import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { lookupExecutable } from "./executable-lookup.js";
import { probeRustEngine } from "./rust-engine.js";

/**
 * Build output is never committed. A candidate that contains (or is) a file
 * git tracks holds authored work, whatever its name - so it is not sweep's to
 * remove.
 *
 * 1. Git is the source of truth: when an absolute `git` executable is on
 *    `PATH`, every enclosing repository is queried via a sanitized
 *    `git ls-files -z --cached` invocation (all inherited `GIT_*` variables
 *    dropped, `core.fsmonitor=false`, `LC_ALL=C`). Its answer counts only on
 *    exit 0 with valid NUL-delimited output; any error, timeout, or parse
 *    problem marks every candidate in that repository `unknown`.
 * 2. The native index reader (via `sweep-engine tracked --status`) is used
 *    only when `git` is unavailable, and its answer counts only when the
 *    repository validates (gitdir, readable `HEAD`, verified index checksum)
 *    with a non-empty index; any validation failure or empty native result is
 *    `unknown`.
 * 3. Every enclosing repository up to the filesystem root is checked.
 */
export const GIT_ARGS = [
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.quotePath=false",
];

/**
 * Hardened environment for git subprocesses:
 * - Drops all inherited `GIT_*` overrides (`GIT_DIR`, `GIT_WORK_TREE`,
 *   `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
 *   `GIT_COMMON_DIR`, `GIT_CEILING_DIRECTORIES`, `GIT_CONFIG_*`, etc.) so
 *   parent environment state cannot redirect or alter git queries.
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

const TIMEOUT_MS = 10_000;

function hasDotGit(dir: string): boolean {
  try {
    lstatSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Every enclosing ancestor holding `.git` (directory, gitfile, or symlink),
 * nearest first up to the filesystem root.
 */
function findEnclosingRepoRoots(
  start: string,
  cache: Map<string, readonly string[]>,
): readonly string[] {
  const chain: string[] = [];
  let dir = start;
  let inherited: readonly string[] = [];
  for (;;) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      inherited = cached;
      break;
    }
    chain.push(dir);
    const parent = dirname(dir);
    if (parent === dir) {
      inherited = [];
      break;
    }
    dir = parent;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const ancestor = chain[i]!;
    if (hasDotGit(ancestor)) {
      inherited = [ancestor, ...inherited];
    }
    cache.set(ancestor, inherited);
  }
  return inherited;
}

export interface GitTrackedResult {
  /** Paths confirmed to be, or contain, git-tracked files. */
  tracked: Set<string>;
  /** Paths inside a git repository whose tracked status could not be checked. */
  unknown: Set<string>;
}

export const TRACKED_STATUS_HEADER = "SWEEP_TRACKED_V3";

function emptyTrackedResult(): GitTrackedResult {
  return { tracked: new Set(), unknown: new Set() };
}

/**
 * Classify `paths` into git-tracked and unknown-status subsets. Paths outside
 * any repository appear in neither set. When a repository's tracked files
 * cannot be verified, its paths are reported in `unknown` so callers fail
 * closed instead of treating them as untracked.
 *
 * When a compatible `SWEEP_TRACKED_V3` native engine is available, it runs the
 * same git-first rule across repositories in parallel (falling back to its
 * validated native index reader only when `git` is unavailable). Without a
 * compatible engine, git answers directly here.
 */
export function gitTrackedPaths(paths: readonly string[]): GitTrackedResult {
  if (paths.length === 0) return emptyTrackedResult();
  return gitTrackedPathsViaEngine(paths) ?? gitTrackedPathsViaGit(paths);
}

/** Null when the engine is unavailable or did not speak `SWEEP_TRACKED_V3` cleanly. */
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
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    !result.stdout.endsWith("\0")
  ) {
    return null;
  }
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

/** Sanitized `git ls-files -z --cached` across every enclosing repository. */
export function gitTrackedPathsViaGit(paths: readonly string[]): GitTrackedResult {
  const tracked = new Set<string>();
  const unknown = new Set<string>();
  if (paths.length === 0) return { tracked, unknown };
  const rootCache = new Map<string, readonly string[]>();
  const byRoot = new Map<string, string[]>();
  for (const path of paths) {
    for (const root of findEnclosingRepoRoots(dirname(path), rootCache)) {
      const list = byRoot.get(root);
      if (list) list.push(path);
      else byRoot.set(root, [path]);
    }
  }
  if (byRoot.size === 0) return { tracked, unknown };
  const gitBinary = lookupExecutable("git").resolvedPath;
  if (!gitBinary) {
    for (const members of byRoot.values()) {
      for (const path of members) unknown.add(path);
    }
    return { tracked, unknown };
  }
  const env = gitEnv();

  for (const [root, members] of byRoot) {
    const relToPath = new Map<string, string>();
    for (const path of members) {
      const rel = relative(root, path).split(sep).join("/");
      if (!rel || rel === ".." || rel.startsWith("../")) {
        unknown.add(path);
        continue;
      }
      relToPath.set(rel, path);
    }
    if (relToPath.size === 0) continue;
    const repoTracked = new Set<string>();
    let repoFailed = false;
    for (const chunk of chunked([...relToPath.keys()])) {
      // `--` ends options: a folder named `-x` stays a path, never a flag.
      const result = spawnSync(
        gitBinary,
        [...GIT_ARGS, "-C", root, "ls-files", "-z", "--cached", "--", ...chunk],
        {
          env,
          encoding: "utf8",
          timeout: TIMEOUT_MS,
          maxBuffer: 256 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      if (
        result.error !== undefined ||
        result.signal !== null ||
        result.status !== 0 ||
        typeof result.stdout !== "string" ||
        (result.stdout.length > 0 && !result.stdout.endsWith("\0"))
      ) {
        repoFailed = true;
        break;
      }
      collect(result.stdout, relToPath, repoTracked);
    }
    if (repoFailed) {
      for (const path of members) unknown.add(path);
    } else {
      for (const path of repoTracked) tracked.add(path);
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
