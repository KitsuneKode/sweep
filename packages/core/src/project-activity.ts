import { lstatSync, opendirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * When was a project last worked on? An artifact's own mtime is the wrong
 * answer: a rebuild touches `target/` and an install touches `node_modules`
 * even in a project nobody has opened in months. The question that decides
 * what is worth cleaning is when a person last touched the project around it.
 *
 * Signals, newest wins:
 * - git activity: the index (rewritten by add, commit, checkout and even a
 *   `status` refresh), HEAD, reflog, and merge/commit state files;
 * - a bounded walk of the project's own non-generated files and folders,
 *   catching in-place edits inside `src/`, `packages/`, etc.
 * Build output, caches and dependency folders never count.
 *
 * Owner decision D4: if activity cannot be proven (a bounded check hits its
 * depth, directory, entry, or time cap, hits an unreadable directory, skips a
 * symlinked directory it will not follow, drops a future-dated signal, or
 * finds no readable signal), activity is `"unknown"` (`activeMs: undefined`)
 * and is never treated as idle or auto-selected for idle cleanup.
 */

/** Files whose presence makes a folder a project root. */
const PROJECT_MARKERS = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "pubspec.yaml",
  "mix.exs",
  "deno.json",
  "Package.swift",
  "CMakeLists.txt",
  "Makefile",
  ".git",
];

/** Generated or vendored: their mtimes say nothing about a person working. */
const IGNORED = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vite",
  ".cache",
  ".parcel-cache",
  ".nyc_output",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".gradle",
  ".pytest_cache",
  ".mypy_cache",
  ".DS_Store",
]);

const GIT_ACTIVITY_FILES = [
  "index",
  join("logs", "HEAD"),
  "HEAD",
  "FETCH_HEAD",
  "MERGE_HEAD",
  "ORIG_HEAD",
  "COMMIT_EDITMSG",
];

const DEFAULT_MAX_SOURCE_DEPTH = 8;
const DEFAULT_MAX_SOURCE_DIRS = 512;
const DEFAULT_MAX_SOURCE_ENTRIES = 4096;
const DEFAULT_TIME_BUDGET_MS = 100;
/** Clock skew tolerated before an mtime counts as future-dated. */
const FUTURE_TOLERANCE_MS = 60_000;

export type ProjectActivityConfidence = "proven" | "unknown";

export interface ProjectActivity {
  /** The folder treated as the project. */
  root: string;
  /**
   * Newest provable human-activity signal, epoch ms; undefined when activity
   * cannot be proven (unknown confidence).
   */
  activeMs: number | undefined;
  /** Whether activity was proven by a complete bounded inspection. */
  confidence: ProjectActivityConfidence;
}

export interface ProjectActivityOptions {
  /** Maximum directory depth below the project root to inspect (default: 8). */
  maxDepth?: number;
  /** Maximum non-ignored directories to read per project (default: 512). */
  maxDirs?: number;
  /** Maximum non-ignored entries to inspect per project (default: 4096). */
  maxEntries?: number;
  /** Wall-clock budget for one project's source walk, ms (default: 100). */
  timeBudgetMs?: number;
  /** Monotonic clock for the time budget (defaults to `performance.now`). */
  clock?: () => number;
  /** Override home directory stop boundary (defaults to `os.homedir()`). */
  homeDir?: string;
}

interface ActivityMeasurement {
  activeMs: number | undefined;
  confidence: ProjectActivityConfidence;
}

interface GitActivityMeasurement {
  activeMs: number | undefined;
  unreadable: boolean;
}

function normalizeForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

function isSameDir(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function hasEntry(dir: string, name: string): boolean {
  try {
    lstatSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The git directory for a work tree: `.git` itself, or a worktree's `gitdir:`. */
function gitDir(root: string): { path: string | undefined; unreadable: boolean } {
  const dotGit = join(root, ".git");
  try {
    const meta = lstatSync(dotGit);
    if (meta.isDirectory()) return { path: dotGit, unreadable: false };
    if (!meta.isFile() || meta.size > 4096) return { path: undefined, unreadable: true };
    const line = readFileSync(dotGit, "utf8").split("\n")[0] ?? "";
    const target = line.startsWith("gitdir:") ? line.slice(7).trim() : "";
    if (!target) return { path: undefined, unreadable: true };
    return { path: isAbsolute(target) ? target : resolve(root, target), unreadable: false };
  } catch (error) {
    if (isMissingError(error)) return { path: undefined, unreadable: false };
    return { path: undefined, unreadable: true };
  }
}

export class ProjectActivityIndex {
  private readonly roots = new Map<string, string | null>();
  private readonly activity = new Map<string, ActivityMeasurement>();
  /** Repeat size updates of one artifact must not walk the tree again. */
  private readonly byPath = new Map<string, ProjectActivity>();
  private readonly repos = new Map<string, GitActivityMeasurement>();
  private readonly maxDepth: number;
  private readonly maxDirs: number;
  private readonly maxEntries: number;
  private readonly timeBudgetMs: number;
  private readonly clock: () => number;
  private readonly home: string;

  /**
   * @param exclude every candidate path in the plan: an artifact named by a
   *   custom pattern must not count as activity in its own project.
   */
  constructor(
    private readonly exclude: ReadonlySet<string> = new Set(),
    private readonly now = Date.now(),
    options: ProjectActivityOptions = {},
  ) {
    this.maxDepth = Math.max(0, options.maxDepth ?? DEFAULT_MAX_SOURCE_DEPTH);
    this.maxDirs = Math.max(1, options.maxDirs ?? DEFAULT_MAX_SOURCE_DIRS);
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_SOURCE_ENTRIES);
    this.timeBudgetMs = Math.max(0, options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
    this.clock = options.clock ?? (() => performance.now());
    this.home = resolve(options.homeDir ?? homedir());
  }

  /**
   * Activity for the project that owns `artifactPath`.
   *
   * The project a person thinks of: the git work tree when there is one (a
   * monorepo, its packages and its caches are one project; each worktree is
   * its own), else the nearest folder with a manifest, else the artifact's
   * parent. A dotfiles repository or manifest at the home folder never counts.
   */
  forArtifact(artifactPath: string): ProjectActivity {
    const cached = this.byPath.get(artifactPath);
    if (cached) return cached;
    const start = dirname(artifactPath);
    const root = this.workTree(start) ?? this.projectRoot(start) ?? start;
    const { activeMs, confidence } = this.projectActivity(root);
    const found: ProjectActivity = { root, activeMs, confidence };
    this.byPath.set(artifactPath, found);
    return found;
  }

  private readonly trees = new Map<string, string | null>();
  private workTree(start: string): string | null {
    const visited: string[] = [];
    let dir = start;
    let found: string | null = null;
    for (;;) {
      const cached = this.trees.get(dir);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      visited.push(dir);
      const parent = dirname(dir);
      if (parent === dir || isSameDir(dir, this.home)) break;
      if (hasEntry(dir, ".git")) {
        found = dir;
        break;
      }
      dir = parent;
    }
    for (const seen of visited) this.trees.set(seen, found);
    return found;
  }

  private projectRoot(start: string): string | null {
    const visited: string[] = [];
    let dir = start;
    let found: string | null = null;
    for (;;) {
      const cached = this.roots.get(dir);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      visited.push(dir);
      const parent = dirname(dir);
      if (parent === dir || isSameDir(dir, this.home)) break;
      if (PROJECT_MARKERS.some((marker) => hasEntry(dir, marker))) {
        found = dir;
        break;
      }
      dir = parent;
    }
    for (const seen of visited) this.roots.set(seen, found);
    return found;
  }

  private projectActivity(root: string): ActivityMeasurement {
    const cached = this.activity.get(root);
    if (cached !== undefined) return cached;

    let newest: number | undefined;
    let complete = true;
    const consider = (value: number | undefined) => {
      if (value === undefined) return;
      // A clock-skewed future mtime must not make a project look busy forever,
      // but dropping it leaves a newer signal unaccounted for: not provable.
      if (value > this.now + FUTURE_TOLERANCE_MS) {
        complete = false;
        return;
      }
      if (newest === undefined || value > newest) newest = value;
    };

    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    let cursor = 0;
    let dirsVisited = 0;
    let entriesVisited = 0;
    const deadline = this.clock() + this.timeBudgetMs;

    walk: while (cursor < queue.length) {
      const current = queue[cursor++]!;
      if (dirsVisited >= this.maxDirs) {
        complete = false;
        break;
      }
      dirsVisited += 1;

      // Iterate instead of materializing the listing, so the entry and time
      // caps stop reading a huge directory early.
      let dir;
      try {
        dir = opendirSync(current.dir);
      } catch {
        complete = false;
        continue;
      }
      try {
        for (;;) {
          if (this.clock() > deadline) {
            complete = false;
            break walk;
          }
          let entry;
          try {
            entry = dir.readSync();
          } catch {
            complete = false;
            break;
          }
          if (entry === null) break;

          const name = entry.name;
          if (IGNORED.has(name) || name.startsWith(".sweep-trash-")) continue;
          const childPath = join(current.dir, name);
          if (this.exclude.has(childPath)) continue;

          entriesVisited += 1;
          if (entriesVisited > this.maxEntries) {
            complete = false;
            break walk;
          }

          let stat;
          try {
            stat = lstatSync(childPath);
          } catch {
            complete = false;
            continue;
          }
          consider(stat.mtimeMs);

          if (stat.isSymbolicLink()) {
            // Symlinks are never followed. A linked directory may hold newer
            // edits we cannot see, so its project is not provable; a linked
            // file's own mtime is one cheap stat away.
            try {
              const target = statSync(childPath);
              if (target.isDirectory()) complete = false;
              else consider(target.mtimeMs);
            } catch (error) {
              if (!isMissingError(error) && (error as NodeJS.ErrnoException).code !== "ELOOP") {
                complete = false;
              }
            }
          } else if (stat.isDirectory()) {
            if (current.depth >= this.maxDepth) {
              complete = false;
            } else {
              queue.push({ dir: childPath, depth: current.depth + 1 });
            }
          }
        }
      } finally {
        dir.closeSync();
      }
    }

    const git = this.gitActivity(root);
    consider(git.activeMs);
    if (git.unreadable) complete = false;

    const result: ActivityMeasurement =
      complete && newest !== undefined
        ? { activeMs: newest, confidence: "proven" }
        : { activeMs: undefined, confidence: "unknown" };
    this.activity.set(root, result);
    return result;
  }

  /** Index and HEAD reflog mtimes of the repository containing `root`. */
  private gitActivity(root: string): GitActivityMeasurement {
    const visited: string[] = [];
    let dir = root;
    let result: GitActivityMeasurement = { activeMs: undefined, unreadable: false };
    for (;;) {
      const cached = this.repos.get(dir);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      visited.push(dir);
      const parent = dirname(dir);
      if (parent === dir || isSameDir(dir, this.home)) break;

      const git = gitDir(dir);
      if (git.unreadable) {
        result = { activeMs: undefined, unreadable: true };
        break;
      }
      if (git.path) {
        let newest: number | undefined;
        let unreadable = false;
        for (const file of GIT_ACTIVITY_FILES) {
          try {
            const value = statSync(join(git.path, file)).mtimeMs;
            if (newest === undefined || value > newest) newest = value;
          } catch (error) {
            if (!isMissingError(error)) unreadable = true;
          }
        }
        result = { activeMs: newest, unreadable };
        break;
      }
      dir = parent;
    }
    for (const seen of visited) this.repos.set(seen, result);
    return result;
  }
}

const DAY = 86_400_000;

/** `30d`, `2w`, `3m`, `1y`, `12h` -> milliseconds. */
export function parseIdleDuration(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(h|d|w|m|mo|y)\s*$/i.exec(value);
  if (!match) {
    throw new Error(`invalid duration "${value}" (use e.g. 30d, 2w, 3m, 1y)`);
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const scale =
    unit === "h"
      ? DAY / 24
      : unit === "d"
        ? DAY
        : unit === "w"
          ? 7 * DAY
          : unit === "y"
            ? 365 * DAY
            : 30 * DAY;
  const ms = amount * scale;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`invalid duration "${value}"`);
  return ms;
}

/** "3mo", "12d", "5h" - how long a project has been idle. */
export function formatIdle(activeMs: number | undefined, now = Date.now()): string {
  if (activeMs === undefined) return "?";
  const ms = Math.max(0, now - activeMs);
  const days = ms / DAY;
  if (days < 1) return `${Math.max(1, Math.round(ms / 3_600_000))}h`;
  if (days < 60) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(days < 3650 ? 1 : 0).replace(/\.0$/, "")}y`;
}
