import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { normalize, parse, resolve } from "node:path";

// ─── Blocked paths ────────────────────────────────────────────────────────────

/**
 * Paths that must never be the target directory.
 * Evaluated AFTER resolve() — these are canonical absolute paths.
 * Built once at module load (not per-call) for performance.
 */
const BLOCKED_ROOTS: Set<string> = new Set([
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
  // Reject path traversal before resolving (defense-in-depth)
  if (targetPath.includes("..")) {
    throw new GuardrailError(`Path traversal detected: ${targetPath}`);
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
  const relativeParts = resolved.slice(root.length).split("/").filter(Boolean);
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
