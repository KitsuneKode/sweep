import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { lookupExecutable } from "./executable-lookup.js";
import { isReparsePointOrSymlink } from "./guardrails.js";
import { probeRustEngine } from "./rust-engine.js";

/**
 * Build output is never committed. A candidate that contains (or is) a file
 * git tracks holds authored work, whatever its name - so it is not sweep's to
 * remove.
 *
 * 1. Git is the source of truth: when an absolute `git` executable is on
 *    `PATH`, every enclosing repository (including the candidate directory
 *    itself when it holds `.git`) is verified with `git rev-parse --show-toplevel`
 *    and queried once via a sanitized `git ls-files -z --cached --full-name`
 *    invocation (all inherited `GIT_*` variables dropped, `core.fsmonitor=false`,
 *    `LC_ALL=C`). Candidates are matched locally using the repository's own
 *    folding rules (`core.ignorecase`, `core.precomposeunicode` / macOS NFC).
 *    Any mismatch, error, timeout, or parse problem marks every candidate in
 *    that repository `unknown`.
 * 2. The native index reader (via `sweep-engine tracked --status`) is used
 *    only when `git` is unavailable, and its answer counts only when the
 *    repository validates (gitdir, common config + `extensions.objectFormat`,
 *    readable regular `HEAD`, verified index checksum for that exact hash
 *    length) with a non-empty index; any validation failure or empty native
 *    result is `unknown`.
 * 3. Every enclosing repository up to the filesystem root is checked, and
 *    real directory candidates are walked with a bounded non-symlink-following
 *    search for any `.git` entry inside them (`containsGitRepo`; hitting a
 *    bound or unreadable directory marks the candidate `unknown`).
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
const MAX_GIT_STDOUT_BYTES = 256 * 1024 * 1024;
const MAX_GIT_META_BYTES = 4 * 1024 * 1024;
const MAX_NESTED_GIT_DIRS = 100_000;
const MAX_NESTED_GIT_ENTRIES = 1_000_000;
const MAX_NESTED_GIT_DEPTH = 128;
const IS_MACOS = process.platform === "darwin";
const IS_WINDOWS = process.platform === "win32";
const CASE_INSENSITIVE_DOT_GIT = IS_MACOS || IS_WINDOWS;

function isRealDirectory(path: string): { isDir: boolean; permissionDenied: boolean } {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { isDir: false, permissionDenied: false };
    }
    if (IS_WINDOWS && isReparsePointOrSymlink(path)) {
      return { isDir: false, permissionDenied: false };
    }
    return { isDir: true, permissionDenied: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { isDir: false, permissionDenied: code === "EACCES" || code === "EPERM" };
  }
}

function hasDotGit(dir: string): boolean {
  try {
    lstatSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

function isDotGitName(name: string): boolean {
  return CASE_INSENSITIVE_DOT_GIT ? name.toLowerCase() === ".git" : name === ".git";
}

export type NestedGitCheckStatus = "found" | "not_found" | "unknown";

export interface NestedGitLimits {
  maxDirs: number;
  maxEntries: number;
  maxDepth: number;
}

/**
 * Bounded non-symlink-following search for any `.git` entry inside a directory
 * candidate. Hitting any bound or an unreadable subdirectory returns `unknown`
 * so callers fail closed instead of assuming no repository exists inside.
 */
export function scanCandidateForDotGit(
  candidate: string,
  limits: NestedGitLimits = {
    maxDirs: MAX_NESTED_GIT_DIRS,
    maxEntries: MAX_NESTED_GIT_ENTRIES,
    maxDepth: MAX_NESTED_GIT_DEPTH,
  },
): NestedGitCheckStatus {
  const rootCheck = isRealDirectory(candidate);
  if (rootCheck.permissionDenied) return "unknown";
  if (!rootCheck.isDir) return "not_found";

  const stack: Array<{ dir: string; depth: number }> = [{ dir: candidate, depth: 0 }];
  let visitedDirs = 0;
  let visitedEntries = 0;
  let sawError = false;

  while (stack.length > 0) {
    const current = stack.pop()!;
    visitedDirs++;
    if (visitedDirs > limits.maxDirs) return "unknown";

    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      sawError = true;
      continue;
    }

    for (const entry of entries) {
      visitedEntries++;
      if (visitedEntries > limits.maxEntries) return "unknown";
      if (isDotGitName(entry.name)) return "found";
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const childPath = join(current.dir, entry.name);
      if (IS_WINDOWS && isReparsePointOrSymlink(childPath)) continue;
      if (current.depth >= limits.maxDepth) return "unknown";
      if (visitedDirs + stack.length >= limits.maxDirs) return "unknown";
      stack.push({ dir: childPath, depth: current.depth + 1 });
    }
  }

  return sawError ? "unknown" : "not_found";
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
  /** Paths inside a git repository (or with bounded-walk overflow) whose tracked status could not be checked. */
  unknown: Set<string>;
  /** Directory candidates containing a `.git` entry at or below them. */
  containsGitRepo: Set<string>;
}

export const TRACKED_STATUS_HEADER = "SWEEP_TRACKED_V4";

function emptyTrackedResult(): GitTrackedResult {
  return { tracked: new Set(), unknown: new Set(), containsGitRepo: new Set() };
}

/**
 * Classify `paths` into git-tracked, unknown-status, and nested-repository
 * subsets. Paths outside any repository with no nested `.git` appear in none
 * of the sets. When a repository's tracked files cannot be verified, its paths
 * are reported in `unknown` so callers fail closed instead of treating them as
 * untracked.
 *
 * When a compatible `SWEEP_TRACKED_V4` native engine is available, it runs the
 * same git-first rule across repositories in parallel (falling back to its
 * validated native index reader only when `git` is unavailable). Without a
 * compatible engine, git answers directly here.
 */
export function gitTrackedPaths(paths: readonly string[]): GitTrackedResult {
  if (paths.length === 0) return emptyTrackedResult();
  return gitTrackedPathsViaEngine(paths) ?? gitTrackedPathsViaGit(paths);
}

/** Null when the engine is unavailable or did not speak `SWEEP_TRACKED_V4` cleanly. */
export function gitTrackedPathsViaEngine(paths: readonly string[]): GitTrackedResult | null {
  const probe = probeRustEngine();
  if (!probe.available || !probe.resolvedPath) return null;
  const result = spawnSync(probe.resolvedPath, ["tracked", "--status"], {
    input: `${paths.join("\0")}\0`,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: MAX_GIT_STDOUT_BYTES,
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
  const containsGitRepo = new Set<string>();
  for (let i = 1; i < records.length; i++) {
    const entry = records[i];
    if (!entry) continue;
    if (entry.startsWith("T\t")) {
      const path = entry.slice(2);
      if (asked.has(path)) tracked.add(path);
    } else if (entry.startsWith("U\t")) {
      const path = entry.slice(2);
      if (asked.has(path)) unknown.add(path);
    } else if (entry.startsWith("R\t")) {
      const path = entry.slice(2);
      if (asked.has(path)) containsGitRepo.add(path);
    } else {
      return null;
    }
  }
  for (const path of tracked) unknown.delete(path);
  return { tracked, unknown, containsGitRepo };
}

interface FoldingRules {
  ignoreCase: boolean;
  precomposeUnicode: boolean;
}

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function foldPath(value: string, rules: FoldingRules): string {
  if (!rules.ignoreCase && !rules.precomposeUnicode) return value;
  const normalized = rules.precomposeUnicode && !isAscii(value) ? value.normalize("NFC") : value;
  return rules.ignoreCase ? normalized.toLowerCase() : normalized;
}

function parseGitBool(raw: string | undefined): boolean | null {
  if (raw === undefined) return true;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return false;
  if (trimmed === "true" || trimmed === "yes" || trimmed === "on" || trimmed === "1") return true;
  if (trimmed === "false" || trimmed === "no" || trimmed === "off" || trimmed === "0") return false;
  return null;
}

const nativeRealpath = realpathSync.native ?? realpathSync;

export function normalizeWinCanonical(path: string): string {
  let stripped = path.replaceAll("/", "\\");
  const upper = stripped.toUpperCase();
  if (upper.startsWith("\\\\?\\UNC\\")) {
    stripped = `\\\\${stripped.slice(8)}`;
  } else if (stripped.startsWith("\\\\?\\")) {
    stripped = stripped.slice(4);
  }
  if (stripped.length > 3 && stripped.endsWith("\\")) {
    stripped = stripped.replace(/\\+$/, "");
  }
  return stripped.toLowerCase();
}

export function sameRepoRoot(expected: string, reported: string): boolean {
  if (!IS_WINDOWS) {
    try {
      const a = statSync(expected, { bigint: true });
      const b = statSync(reported, { bigint: true });
      if (a.ino !== 0n && b.ino !== 0n) {
        return a.dev === b.dev && a.ino === b.ino;
      }
    } catch {
      // Fall through to realpath comparison.
    }
  }
  try {
    const a = nativeRealpath(expected);
    const b = nativeRealpath(reported);
    return IS_WINDOWS ? normalizeWinCanonical(a) === normalizeWinCanonical(b) : a === b;
  } catch {
    return false;
  }
}

function runGitSubcommand(
  gitBinary: string,
  root: string,
  subcommandArgs: readonly string[],
  env: NodeJS.ProcessEnv,
  maxBuffer: number,
): string | null {
  const result = spawnSync(gitBinary, [...GIT_ARGS, "-C", root, ...subcommandArgs], {
    env,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== "string"
  ) {
    return null;
  }
  return result.stdout;
}

function verifyGitToplevel(gitBinary: string, root: string, env: NodeJS.ProcessEnv): boolean {
  const stdout = runGitSubcommand(
    gitBinary,
    root,
    ["rev-parse", "--show-toplevel"],
    env,
    MAX_GIT_META_BYTES,
  );
  if (stdout === null) return false;
  const trimmed = stdout.replace(/[\r\n]+$/, "");
  if (!trimmed || /[\0\r\n]/.test(trimmed)) return false;
  return sameRepoRoot(root, trimmed);
}

function readGitFoldingConfig(
  gitBinary: string,
  root: string,
  env: NodeJS.ProcessEnv,
): FoldingRules | null {
  const stdout = runGitSubcommand(
    gitBinary,
    root,
    ["config", "--list", "--null"],
    env,
    MAX_GIT_META_BYTES,
  );
  if (stdout === null) return null;
  if (stdout.length > 0 && !stdout.endsWith("\0")) return null;
  let ignoreCase = false;
  let precomposeUnicode = false;
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const nl = record.indexOf("\n");
    const key = nl < 0 ? record : record.slice(0, nl);
    const val = nl < 0 ? undefined : record.slice(nl + 1);
    if (key === "core.ignorecase") {
      const parsed = parseGitBool(val);
      if (parsed === null) return null;
      ignoreCase = parsed;
    } else if (key === "core.precomposeunicode") {
      const parsed = parseGitBool(val);
      if (parsed === null) return null;
      precomposeUnicode = parsed;
    }
  }
  return {
    ignoreCase,
    precomposeUnicode: precomposeUnicode || IS_MACOS,
  };
}

function matchEntries(
  entries: readonly string[],
  rels: ReadonlyArray<{ rel: string; path: string }>,
  rules: FoldingRules,
  tracked: Set<string>,
): void {
  if (rels.length === 0) return;
  const byKey = new Map<string, string[]>();
  for (const item of rels) {
    const key = foldPath(item.rel, rules);
    const list = byKey.get(key);
    if (list) list.push(item.path);
    else byKey.set(key, [item.path]);
  }
  for (const file of entries) {
    let prefix = foldPath(file, rules);
    for (;;) {
      const paths = byKey.get(prefix);
      if (paths !== undefined) {
        for (const path of paths) tracked.add(path);
      }
      const cut = prefix.lastIndexOf("/");
      if (cut < 0) break;
      prefix = prefix.slice(0, cut);
    }
  }
}

/**
 * Sanitized `git ls-files -z --cached --full-name` across every enclosing
 * repository (including directory candidates themselves) plus bounded `.git`
 * descent inside directory candidates.
 */
export function gitTrackedPathsViaGit(paths: readonly string[]): GitTrackedResult {
  const tracked = new Set<string>();
  const unknown = new Set<string>();
  const containsGitRepo = new Set<string>();
  if (paths.length === 0) return { tracked, unknown, containsGitRepo };

  const rootCache = new Map<string, readonly string[]>();
  const byRoot = new Map<string, string[]>();
  const dirCandidates: string[] = [];

  for (const path of paths) {
    const dirCheck = isRealDirectory(path);
    if (dirCheck.permissionDenied) unknown.add(path);
    const start = dirCheck.isDir ? path : dirname(path);
    for (const root of findEnclosingRepoRoots(start, rootCache)) {
      const list = byRoot.get(root);
      if (list) list.push(path);
      else byRoot.set(root, [path]);
    }
    if (dirCheck.isDir) {
      dirCandidates.push(path);
    }
  }

  for (const dir of dirCandidates) {
    const nested = scanCandidateForDotGit(dir);
    if (nested === "found") containsGitRepo.add(dir);
    else if (nested === "unknown") unknown.add(dir);
  }

  if (byRoot.size === 0) {
    for (const path of tracked) unknown.delete(path);
    return { tracked, unknown, containsGitRepo };
  }

  const gitBinary = lookupExecutable("git").resolvedPath;
  if (!gitBinary) {
    for (const members of byRoot.values()) {
      for (const path of members) unknown.add(path);
    }
    for (const path of tracked) unknown.delete(path);
    return { tracked, unknown, containsGitRepo };
  }
  const env = gitEnv();

  const baseRules: FoldingRules = { ignoreCase: false, precomposeUnicode: IS_MACOS };
  const maxRules: FoldingRules = { ignoreCase: true, precomposeUnicode: true };

  for (const [root, members] of byRoot) {
    const repoRootMembers: string[] = [];
    const rels: Array<{ rel: string; path: string }> = [];
    for (const path of members) {
      const rawRel = relative(root, path);
      if (rawRel === "") {
        repoRootMembers.push(path);
        continue;
      }
      const rel = IS_WINDOWS ? rawRel.split(sep).join("/") : rawRel;
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        unknown.add(path);
        continue;
      }
      rels.push({ rel, path });
    }
    if (repoRootMembers.length === 0 && rels.length === 0) continue;

    if (!verifyGitToplevel(gitBinary, root, env)) {
      for (const path of members) unknown.add(path);
      continue;
    }

    const stdout = runGitSubcommand(
      gitBinary,
      root,
      ["ls-files", "-z", "--cached", "--full-name"],
      env,
      MAX_GIT_STDOUT_BYTES,
    );
    if (stdout === null || (stdout.length > 0 && !stdout.endsWith("\0"))) {
      for (const path of members) unknown.add(path);
      continue;
    }
    const entries = stdout.split("\0").filter((entry) => entry.length > 0);
    if (entries.length === 0) continue;

    const repoTracked = new Set<string>();
    for (const path of repoRootMembers) repoTracked.add(path);

    if (rels.length > 0) {
      matchEntries(entries, rels, baseRules, repoTracked);
      const remaining = rels.filter((item) => !repoTracked.has(item.path));
      if (remaining.length > 0) {
        const potential = new Set<string>();
        matchEntries(entries, remaining, maxRules, potential);
        if (potential.size > 0) {
          const rules = readGitFoldingConfig(gitBinary, root, env);
          if (rules === null) {
            for (const path of members) unknown.add(path);
            continue;
          }
          if (
            rules.ignoreCase !== baseRules.ignoreCase ||
            rules.precomposeUnicode !== baseRules.precomposeUnicode
          ) {
            matchEntries(entries, remaining, rules, repoTracked);
          }
        }
      }
    }

    for (const path of repoTracked) tracked.add(path);
  }

  for (const path of tracked) unknown.delete(path);
  return { tracked, unknown, containsGitRepo };
}
