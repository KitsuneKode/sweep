import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { readTrackedPathsFromIndex } from "./git-index.js";
import { isRustEngineAvailable, resolveRustEngineBinary } from "./rust-engine.js";

/**
 * Build output is never committed. A candidate that contains (or is) a file
 * git tracks holds authored work, whatever its name - so it is not sweep's to
 * remove. Reading `.git/index` directly (or one hardened `git ls-files` per
 * repository on unsupported index layouts) answers that for every candidate
 * inside it.
 *
 * Running git inside a repository sweep did not create means running with
 * that repository's config. Every git call drops inherited `GIT_*` overrides,
 * forces the C locale, disables network protocols, fsmonitor, and hooks, and
 * takes no optional locks.
 */

let emptyHooksDir: string | undefined;

/** Empty directory passed to `-c core.hooksPath=...` so repo/global hooks never run. */
export function emptyGitHooksDir(): string {
  if (emptyHooksDir && existsSync(emptyHooksDir)) return emptyHooksDir;
  emptyHooksDir = mkdtempSync(join(tmpdir(), "sweep-no-hooks-"));
  process.once("exit", () => {
    if (!emptyHooksDir) return;
    try {
      rmSync(emptyHooksDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on exit.
    }
  });
  return emptyHooksDir;
}

/** Static hardened git flags (combine with `gitSafeArgs()` for the empty hooks path). */
export const GIT_ARGS = [
  "--no-pager",
  "-c",
  "protocol.allow=never",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.quotePath=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];

/** Hardened git CLI flags including `-c core.hooksPath=<empty dir>`. */
export function gitSafeArgs(): string[] {
  return [...GIT_ARGS, "-c", `core.hooksPath=${emptyGitHooksDir()}`];
}

/**
 * Hardened environment for git subprocesses:
 * - Drops all inherited `GIT_*` overrides (`GIT_DIR`, `GIT_WORK_TREE`,
 *   `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
 *   `GIT_COMMON_DIR`, `GIT_CONFIG_*`, etc.) so parent environment state cannot
 *   redirect or alter git queries.
 * - Forces C locale and disables lazy fetches, replace objects, prompts, and
 *   optional locks.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (/^git_/i.test(key)) continue;
    clean[key] = value;
  }
  clean.LC_ALL = "C";
  clean.LANG = "C";
  clean.LANGUAGE = "C";
  clean.GIT_OPTIONAL_LOCKS = "0";
  // Pathspecs are paths, never globs: a folder named `*` must not match all.
  clean.GIT_LITERAL_PATHSPECS = "1";
  clean.GIT_TERMINAL_PROMPT = "0";
  clean.GIT_NO_LAZY_FETCH = "1";
  clean.GIT_NO_REPLACE_OBJECTS = "1";
  return clean;
}

export const GIT_ENV: NodeJS.ProcessEnv = gitEnv();

const TIMEOUT_MS = 10_000;

/** Nearest ancestor holding `.git` (a directory, or a file for worktrees). */
function findRepoRoot(start: string, cache: Map<string, string | null>): string | null {
  const visited: string[] = [];
  let dir = start;
  for (;;) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      for (const seen of visited) cache.set(seen, cached);
      return cached;
    }
    visited.push(dir);
    if (existsSync(join(dir, ".git"))) {
      for (const seen of visited) cache.set(seen, dir);
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      for (const seen of visited) cache.set(seen, null);
      return null;
    }
    dir = parent;
  }
}

/**
 * The subset of `paths` that are, or contain, git-tracked files. Paths outside
 * any repository, and repositories git cannot read, are reported as untracked:
 * this check only ever adds protection, it never removes any.
 *
 * The native engine answers this by reading each repository's index itself,
 * in parallel and without running git (about ten times faster on a tree of
 * many repositories). Without it, the pure JS read-only index reader handles
 * ordinary and split indexes without spawning git or mutating mtimes; only
 * unsupported layouts fall back to hardened `git ls-files`.
 */
export function gitTrackedPaths(paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set();
  return gitTrackedPathsViaEngine(paths) ?? gitTrackedPathsViaIndexOrGit(paths);
}

/** Null when the engine is unavailable or did not answer cleanly. */
export function gitTrackedPathsViaEngine(paths: readonly string[]): Set<string> | null {
  if (!isRustEngineAvailable()) return null;
  const result = spawnSync(resolveRustEngineBinary(), ["tracked"], {
    input: `${paths.join("\0")}\0`,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  // Only ever answer about paths that were asked about.
  const asked = new Set(paths);
  return new Set(result.stdout.split("\0").filter((path) => asked.has(path)));
}

function containsTrackedSorted(sortedPaths: readonly string[], rel: string): boolean {
  let lo = 0;
  let hi = sortedPaths.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const entry = sortedPaths[mid]!;
    if (entry === rel) return true;
    if (entry < rel) lo = mid + 1;
    else hi = mid - 1;
  }
  const prefix = `${rel}/`;
  lo = 0;
  hi = sortedPaths.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedPaths[mid]! < prefix) lo = mid + 1;
    else hi = mid;
  }
  return lo < sortedPaths.length && sortedPaths[lo]!.startsWith(prefix);
}

/** Read-only index parser per repo, falling back to hardened `git ls-files` only if unsupported. */
function gitTrackedPathsViaIndexOrGit(paths: readonly string[]): Set<string> {
  const tracked = new Set<string>();
  if (paths.length === 0) return tracked;
  const rootCache = new Map<string, string | null>();
  const byRoot = new Map<string, string[]>();
  for (const path of paths) {
    const root = findRepoRoot(dirname(path), rootCache);
    if (!root) continue;
    const list = byRoot.get(root);
    if (list) list.push(path);
    else byRoot.set(root, [path]);
  }

  const fallbackPaths: string[] = [];
  for (const [root, members] of byRoot) {
    const indexed = readTrackedPathsFromIndex(root);
    if (indexed === null) {
      fallbackPaths.push(...members);
      continue;
    }
    for (const path of members) {
      const rel = relative(root, path).split(sep).join("/");
      if (containsTrackedSorted(indexed, rel)) tracked.add(path);
    }
  }

  if (fallbackPaths.length > 0) {
    for (const path of gitTrackedPathsViaGit(fallbackPaths)) tracked.add(path);
  }
  return tracked;
}

/** One hardened `git ls-files` per repository. */
export function gitTrackedPathsViaGit(paths: readonly string[]): Set<string> {
  const tracked = new Set<string>();
  if (paths.length === 0) return tracked;
  const rootCache = new Map<string, string | null>();
  const byRoot = new Map<string, string[]>();
  for (const path of paths) {
    const root = findRepoRoot(dirname(path), rootCache);
    if (!root) continue;
    const list = byRoot.get(root);
    if (list) list.push(path);
    else byRoot.set(root, [path]);
  }

  const safeArgs = gitSafeArgs();
  const env = gitEnv();

  for (const [root, members] of byRoot) {
    const relToPath = new Map<string, string>();
    for (const path of members) relToPath.set(relative(root, path).split(sep).join("/"), path);
    for (const chunk of chunked([...relToPath.keys()])) {
      // `--` ends options: a folder named `-x` stays a path, never a flag.
      const result = spawnSync(
        "git",
        [...safeArgs, "-C", root, "ls-files", "-z", "--cached", "--", ...chunk],
        {
          env,
          encoding: "utf8",
          timeout: TIMEOUT_MS,
          maxBuffer: 256 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      if (result.status !== 0 || typeof result.stdout !== "string") continue;
      collect(result.stdout, relToPath, tracked);
    }
  }
  return tracked;
}

/** Map each tracked file back to the candidate that contains it. */
function collect(stdout: string, relToPath: Map<string, string>, tracked: Set<string>): void {
  for (const file of stdout.split("\0")) {
    if (!file) continue;
    let rel = file;
    for (;;) {
      const path = relToPath.get(rel);
      if (path !== undefined) {
        tracked.add(path);
        break;
      }
      const cut = rel.lastIndexOf("/");
      if (cut < 0) break;
      rel = rel.slice(0, cut);
    }
  }
}

/** Keep each git invocation well under the OS argument-length limit. */
function chunked(paths: string[], maxBytes = 64 * 1024): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (current.length > 0 && bytes + size > maxBytes) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(path);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
