import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

// ─── Blocked paths ────────────────────────────────────────────────────────────

/** VCS dirs - never delete artifacts inside these path segments. */
export const PROTECTED_VCS_DIR_NAMES = new Set([".git", ".svn", ".hg", ".bzr"]);

/**
 * Paths that must never be the target directory.
 * Evaluated AFTER resolve() - these are canonical absolute paths.
 * Built once at module load (not per-call) for performance.
 */
function buildBlockedRoots(): Set<string> {
  const roots = new Set<string>([
    "/",
    "/home",
    "/usr",
    "/usr/local",
    "/etc",
    "/opt",
    "/var",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/boot",
    "/sys",
    "/proc",
    "/dev",
    homedir(),
  ]);

  if (process.platform === "win32") {
    for (const drive of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const letter = `${drive}:\\`;
      roots.add(normalize(letter).toLowerCase());
      roots.add(normalize(`${letter}Windows`).toLowerCase());
      roots.add(normalize(`${letter}Program Files`).toLowerCase());
      roots.add(normalize(`${letter}Program Files (x86)`).toLowerCase());
      roots.add(normalize(`${letter}Users`).toLowerCase());
      roots.add(normalize(`${letter}ProgramData`).toLowerCase());
      roots.add(normalize(`${letter}usr\\local`).toLowerCase());
      roots.add(normalize(`${letter}usr`).toLowerCase());
      roots.add(normalize(`${letter}etc`).toLowerCase());
    }
  }

  return roots;
}

const BLOCKED_ROOTS = buildBlockedRoots();

// Case-insensitive filesystems (macOS APFS default, Windows NTFS) make
// /USERS/name the same directory as /Users/name - the blocked-root check must
// fold both sides or a case-variant spelling walks straight past it.
const CASE_FOLD_BLOCKED = process.platform === "win32" || process.platform === "darwin";
const BLOCKED_ROOTS_LOWER = new Set([...BLOCKED_ROOTS].map((root) => root.toLowerCase()));

// ─── Error type ───────────────────────────────────────────────────────────────

export class GuardrailError extends Error {
  /** Maps to process.exit() code */
  readonly code: number;

  constructor(message: string, code = 2) {
    super(message);
    this.name = "GuardrailError";
    this.code = code;
  }
}

// ─── Checks ───────────────────────────────────────────────────────────────────

/**
 * Assert that the target directory is safe to operate on.
 * Throws GuardrailError (exit code 2) if not.
 */
export function assertSafeCwd(targetPath: string): void {
  // Reject null bytes - can confuse C-level FS calls
  if (targetPath.includes("\x00")) {
    throw new GuardrailError(`Path contains null byte: ${JSON.stringify(targetPath)}`);
  }

  const resolved = normalize(resolve(targetPath));
  const isBlocked =
    BLOCKED_ROOTS.has(resolved) ||
    (CASE_FOLD_BLOCKED && BLOCKED_ROOTS_LOWER.has(resolved.toLowerCase()));

  if (isBlocked) {
    throw new GuardrailError(
      `Refusing to operate on protected path: ${sanitizeTerminalText(resolved)}\n` +
        `  sweep must be run inside a project directory, not at a system root.`,
    );
  }

  // Must be at least 2 path segments deep (e.g., /home/user → ok, /tmp → blocked)
  const { root } = parse(resolved);
  const relativeParts = pathSegmentsBelowRoot(resolved, root);
  if (relativeParts.length < 2) {
    throw new GuardrailError(
      `Path is too shallow to be a project directory: ${sanitizeTerminalText(resolved)}\n` +
        `  Expected at least 2 path segments below filesystem root.`,
    );
  }
}

/**
 * Assert that the target exists and is a directory. Kept separate from
 * assertSafeCwd, which is pure safety policy - tests assert the safety of
 * hypothetical paths that need not exist. statSync follows symlinks: a
 * symlinked directory is a valid target, a dangling link reports as missing.
 * Throws GuardrailError (exit code 2) - a usage error, checked before scanning.
 */
export function assertTargetDirectory(targetPath: string): void {
  const resolved = resolve(targetPath);
  let stat;
  try {
    stat = statSync(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const shown = sanitizeTerminalText(resolved);
    if (code === "EACCES" || code === "EPERM") {
      throw new GuardrailError(`Permission denied reading directory: ${shown}`);
    }
    throw new GuardrailError(`Directory does not exist: ${shown}`);
  }
  if (!stat.isDirectory()) {
    throw new GuardrailError(`Path is not a directory: ${sanitizeTerminalText(resolved)}`);
  }
}

/** Patterns are filenames, not essays - beyond this they only burn CPU. */
const MAX_PATTERN_LENGTH = 256;

/**
 * Assert that a pattern string is safe (won't escape the target directory).
 */
export function assertSafePattern(pattern: string): void {
  if (!pattern || pattern.trim().length === 0) {
    throw new GuardrailError("Pattern must not be empty.");
  }
  const shown = sanitizeTerminalText(pattern);
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new GuardrailError(
      `Pattern exceeds ${MAX_PATTERN_LENGTH} characters: "${shown.slice(0, 64)}…"`,
    );
  }
  if (pattern !== pattern.trim()) {
    throw new GuardrailError(`Pattern must not have leading or trailing whitespace: "${shown}"`);
  }
  if (pattern.includes("\x00")) {
    throw new GuardrailError(`Pattern contains null byte: ${JSON.stringify(pattern)}`);
  }
  if (pattern.startsWith("/")) {
    throw new GuardrailError(
      `Patterns must not start with /: "${shown}"\n` +
        `  Use directory names or glob patterns like "*.tsbuildinfo".`,
    );
  }
  if (pattern.includes("..")) {
    throw new GuardrailError(`Patterns must not contain ".." traversal: "${shown}"`);
  }
}

/**
 * Assert that the estimated total size is within the configured limit.
 * Requires --force-large to bypass (which must be combined with --yes).
 */
export function assertSizeLimit(
  estimatedBytes: number,
  maxSizeGB: number,
  forceLarge: boolean,
): void {
  const estimatedGB = estimatedBytes / 1024 ** 3;
  if (estimatedGB > maxSizeGB && !forceLarge) {
    throw new GuardrailError(
      `Estimated size (${estimatedGB.toFixed(1)} GB) exceeds limit (${maxSizeGB} GB).\n` +
        `  Use --force-large --yes to proceed anyway.`,
    );
  }
}

/**
 * Check if a filesystem entry is a symlink.
 * Uses lstatSync to avoid following the link.
 */
export function isSymlink(entryPath: string): boolean {
  try {
    return lstatSync(entryPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * True for symlinks and Windows junctions/reparse points that must not be recursed.
 */
export function isReparsePointOrSymlink(entryPath: string): boolean {
  try {
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      return true;
    }
    if (process.platform === "win32" && stat.isDirectory()) {
      try {
        const parent = dirname(resolve(entryPath));
        const parentReal = realpathSync(parent).replace(/^\\\\\?\\/, "");
        const entryReal = realpathSync(entryPath).replace(/^\\\\\?\\/, "");
        const expectedReal = join(parentReal, basename(entryPath));
        return normalize(entryReal).toLowerCase() !== normalize(expectedReal).toLowerCase();
      } catch {
        return false;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** Path segments below the filesystem root (platform-aware). */
export function pathSegmentsBelowRoot(resolved: string, parsedRoot: string): string[] {
  const tail = resolved.slice(parsedRoot.length);
  return tail.split(sep).filter(Boolean);
}

/** Whether `candidatePath` is the target root or a path inside it. */
export function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const root = normalize(resolve(rootPath));
  const candidate = normalize(resolve(candidatePath));
  if (candidate === root) {
    return true;
  }
  if (process.platform === "win32" && candidate.toLowerCase() === root.toLowerCase()) {
    return true;
  }
  const rel = relative(root, candidate);
  if (rel === "") {
    return true;
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return false;
  }
  return true;
}

/** True when any path segment is a protected VCS metadata directory. */
export function pathHasProtectedVcsSegment(entryPath: string): boolean {
  const insensitive = process.platform === "darwin" || process.platform === "win32";
  const segments = normalize(entryPath).split(sep);
  return segments.some((segment) =>
    PROTECTED_VCS_DIR_NAMES.has(insensitive ? segment.toLowerCase() : segment),
  );
}
