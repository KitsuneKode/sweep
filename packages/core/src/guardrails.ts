import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, parse, relative, resolve, sep } from "node:path";

// ─── Blocked paths ────────────────────────────────────────────────────────────

/** VCS dirs — never delete artifacts inside these path segments. */
export const PROTECTED_VCS_DIR_NAMES = new Set([".git", ".svn", ".hg", ".bzr"]);

/**
 * Paths that must never be the target directory.
 * Evaluated AFTER resolve() — these are canonical absolute paths.
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
      roots.add(normalize(letter));
      roots.add(normalize(`${letter}Windows`));
      roots.add(normalize(`${letter}Program Files`));
      roots.add(normalize(`${letter}Program Files (x86)`));
      roots.add(normalize(`${letter}Users`));
      roots.add(normalize(`${letter}ProgramData`));
    }
  }

  return roots;
}

const BLOCKED_ROOTS = buildBlockedRoots();

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
  // Reject null bytes — can confuse C-level FS calls
  if (targetPath.includes("\x00")) {
    throw new GuardrailError(`Path contains null byte: ${JSON.stringify(targetPath)}`);
  }

  const resolved = normalize(resolve(targetPath));

  if (BLOCKED_ROOTS.has(resolved)) {
    throw new GuardrailError(
      `Refusing to operate on protected path: ${resolved}\n` +
        `  sweep must be run inside a project directory, not at a system root.`,
    );
  }

  // Must be at least 2 path segments deep (e.g., /home/user → ok, /tmp → blocked)
  const { root } = parse(resolved);
  const relativeParts = pathSegmentsBelowRoot(resolved, root);
  if (relativeParts.length < 2) {
    throw new GuardrailError(
      `Path is too shallow to be a project directory: ${resolved}\n` +
        `  Expected at least 2 path segments below filesystem root.`,
    );
  }
}

/**
 * Assert that a pattern string is safe (won't escape the target directory).
 */
export function assertSafePattern(pattern: string): void {
  if (!pattern || pattern.trim().length === 0) {
    throw new GuardrailError("Pattern must not be empty.");
  }
  if (pattern !== pattern.trim()) {
    throw new GuardrailError(`Pattern must not have leading or trailing whitespace: "${pattern}"`);
  }
  if (pattern.includes("\x00")) {
    throw new GuardrailError(`Pattern contains null byte: ${JSON.stringify(pattern)}`);
  }
  if (pattern.startsWith("/")) {
    throw new GuardrailError(
      `Patterns must not start with /: "${pattern}"\n` +
        `  Use directory names or glob patterns like "*.tsbuildinfo".`,
    );
  }
  if (pattern.includes("..")) {
    throw new GuardrailError(`Patterns must not contain ".." traversal: "${pattern}"`);
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
        const real = realpathSync.native(entryPath);
        return normalize(real) !== normalize(resolve(entryPath));
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

/**
 * Assert a candidate deletion path stays inside the plan target directory.
 * Throws GuardrailError (exit code 2) if not.
 */
export function assertPathWithinRoot(
  candidatePath: string,
  rootPath: string,
  label = "Candidate path",
): void {
  if (!isPathWithinRoot(candidatePath, rootPath)) {
    throw new GuardrailError(
      `${label} is outside the scan target:\n` +
        `  ${candidatePath}\n` +
        `  target: ${resolve(rootPath)}`,
    );
  }
}

/** True when any path segment is a protected VCS metadata directory. */
export function pathHasProtectedVcsSegment(entryPath: string): boolean {
  const segments = normalize(entryPath).split(sep);
  return segments.some((segment) => PROTECTED_VCS_DIR_NAMES.has(segment));
}
