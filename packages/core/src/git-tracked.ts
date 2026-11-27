import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { lookupExecutable } from "./executable-lookup.js";
import { probeRustEngine } from "./rust-engine.js";

/**
 * Build output is never committed. A candidate that contains (or is) a file
 * git tracks holds authored work, whatever its name - so it is not sweep's to
 * remove. One `git ls-files` per repository answers that for every candidate
 * inside it.
 *
 * Running git inside a repository sweep did not create means running with
 * that repository's config. `core.fsmonitor` can name a program to execute,
 * so every call disables it, takes no optional locks and reads only the index.
 */
const GIT_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.quotePath=false",
];
const GIT_ENV_OVERRIDES = {
  GIT_OPTIONAL_LOCKS: "0",
  // Pathspecs are paths, never globs: a folder named `*` must not match all.
  GIT_LITERAL_PATHSPECS: "1",
  GIT_TERMINAL_PROMPT: "0",
};
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

export interface GitTrackedResult {
  /** Paths confirmed to be, or contain, git-tracked files. */
  tracked: Set<string>;
  /** Paths inside a git repository whose tracked status could not be checked. */
  unknown: Set<string>;
}

const TRACKED_STATUS_HEADER = "SWEEP_TRACKED_V2";

function emptyTrackedResult(): GitTrackedResult {
  return { tracked: new Set(), unknown: new Set() };
}

/**
 * Classify `paths` into git-tracked and unknown-status subsets. Paths outside
 * any repository appear in neither set. When a repository's tracked files
 * cannot be verified, its paths are reported in `unknown` so callers fail
 * closed instead of treating them as untracked.
 *
 * The native engine answers this by reading each repository's index itself,
 * in parallel and without running git (about ten times faster on a tree of
 * many repositories). Without it, or if it fails, git answers.
 */
export function gitTrackedPaths(paths: readonly string[]): GitTrackedResult {
  if (paths.length === 0) return emptyTrackedResult();
  return gitTrackedPathsViaEngine(paths) ?? gitTrackedPathsViaGit(paths);
}

/** Null when the engine is unavailable or did not answer cleanly. */
export function gitTrackedPathsViaEngine(paths: readonly string[]): GitTrackedResult | null {
  const probe = probeRustEngine();
  if (!probe.available || !probe.resolvedPath) return null;
  const result = spawnSync(probe.resolvedPath, ["tracked", "--status"], {
    input: `${paths.join("\0")}\0`,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const records = result.stdout.split("\0");
  if (records[0] !== TRACKED_STATUS_HEADER) return null;
  // Only ever answer about paths that were asked about.
  const asked = new Set(paths);
  const tracked = new Set<string>();
  const unknown = new Set<string>();
  for (let i = 1; i < records.length; i++) {
    const entry = records[i];
    if (!entry) continue;
    if (entry.startsWith("T\t")) {
      const path = entry.slice(2);
      if (asked.has(path)) tracked.add(path);
    } else if (entry.startsWith("U\t")) {
      const path = entry.slice(2);
      if (asked.has(path)) unknown.add(path);
    } else {
      return null;
    }
  }
  for (const path of tracked) unknown.delete(path);
  return { tracked, unknown };
}

/** One hardened `git ls-files` per repository. */
export function gitTrackedPathsViaGit(paths: readonly string[]): GitTrackedResult {
  const tracked = new Set<string>();
  const unknown = new Set<string>();
  if (paths.length === 0) return { tracked, unknown };
  const rootCache = new Map<string, string | null>();
  const byRoot = new Map<string, string[]>();
  for (const path of paths) {
    const root = findRepoRoot(dirname(path), rootCache);
    if (!root) continue;
    const list = byRoot.get(root);
    if (list) list.push(path);
    else byRoot.set(root, [path]);
  }
  if (byRoot.size === 0) return { tracked, unknown };
  const gitBinary = lookupExecutable("git").resolvedPath;
  if (!gitBinary) {
    for (const members of byRoot.values()) {
      for (const path of members) unknown.add(path);
    }
    return { tracked, unknown };
  }
  const gitEnv = { ...process.env, ...GIT_ENV_OVERRIDES };

  for (const [root, members] of byRoot) {
    const relToPath = new Map<string, string>();
    for (const path of members) relToPath.set(relative(root, path).split(sep).join("/"), path);
    for (const chunk of chunked([...relToPath.keys()])) {
      // `--` ends options: a folder named `-x` stays a path, never a flag.
      const result = spawnSync(
        gitBinary,
        [...GIT_ARGS, "-C", root, "ls-files", "-z", "--cached", "--", ...chunk],
        {
          env: gitEnv,
          encoding: "utf8",
          timeout: TIMEOUT_MS,
          maxBuffer: 256 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      if (result.status !== 0 || typeof result.stdout !== "string") {
        for (const rel of chunk) {
          const path = relToPath.get(rel);
          if (path !== undefined) unknown.add(path);
        }
        continue;
      }
      collect(result.stdout, relToPath, tracked);
    }
  }
  for (const path of tracked) unknown.delete(path);
  return { tracked, unknown };
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
