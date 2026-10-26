import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

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
const GIT_ENV = {
  ...process.env,
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

/**
 * The subset of `paths` that are, or contain, git-tracked files. Paths outside
 * any repository, and repositories git cannot read, are reported as untracked:
 * this check only ever adds protection, it never removes any.
 */
export function gitTrackedPaths(paths: readonly string[]): Set<string> {
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

  for (const [root, members] of byRoot) {
    const relToPath = new Map<string, string>();
    for (const path of members) relToPath.set(relative(root, path).split(sep).join("/"), path);
    for (const chunk of chunked([...relToPath.keys()])) {
      // `--` ends options: a folder named `-x` stays a path, never a flag.
      const result = spawnSync(
        "git",
        [...GIT_ARGS, "-C", root, "ls-files", "-z", "--cached", "--", ...chunk],
        {
          env: GIT_ENV,
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
