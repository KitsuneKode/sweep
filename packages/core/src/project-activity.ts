import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * When was a project last worked on? An artifact's own mtime is the wrong
 * answer: a rebuild touches `target/` and an install touches `node_modules`
 * even in a project nobody has opened in months. The question that decides
 * what is worth cleaning is when a person last touched the project around it.
 *
 * Signals, newest wins:
 * - git activity: the index (rewritten by add, commit, checkout and even a
 *   `status` refresh) and the HEAD reflog (commits, checkouts, pulls);
 * - the project root's own entries: manifests, lockfiles, config, and the
 *   source folders whose mtimes move when an editor saves by rename.
 * Build output, caches and dependency folders never count.
 *
 * One readdir and a few dozen stats per project; results are cached per
 * project root, so a monorepo with forty `node_modules` pays once.
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
  ".cache",
  ".parcel-cache",
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
const MAX_ROOT_ENTRIES = 256;

export interface ProjectActivity {
  /** The folder treated as the project. */
  root: string;
  /** Newest human-activity signal, epoch ms; undefined when none could be read. */
  activeMs: number | undefined;
}

function mtimeMs(path: string): number | undefined {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

const MARKER_SET = new Set(PROJECT_MARKERS);

/** The git directory for a work tree: `.git` itself, or a worktree's `gitdir:`. */
function gitDir(root: string): string | undefined {
  const dotGit = join(root, ".git");
  try {
    const meta = lstatSync(dotGit);
    if (meta.isDirectory()) return dotGit;
    if (!meta.isFile() || meta.size > 4096) return undefined;
    const line = readFileSync(dotGit, "utf8").split("\n")[0] ?? "";
    const target = line.startsWith("gitdir:") ? line.slice(7).trim() : "";
    if (!target) return undefined;
    return isAbsolute(target) ? target : resolve(root, target);
  } catch {
    return undefined;
  }
}

export class ProjectActivityIndex {
  private readonly roots = new Map<string, string | null>();
  /** One readdir per folder, shared by root detection and activity. */
  private readonly listings = new Map<string, string[]>();
  private readonly activity = new Map<string, number | undefined>();
  private readonly repos = new Map<string, number | undefined>();

  /**
   * @param exclude every candidate path in the plan: an artifact named by a
   *   custom pattern must not count as activity in its own project.
   */
  constructor(
    private readonly exclude: ReadonlySet<string> = new Set(),
    private readonly now = Date.now(),
  ) {}

  /** Activity for the project that owns `artifactPath`. */
  forArtifact(artifactPath: string): ProjectActivity {
    const root = this.projectRoot(dirname(artifactPath)) ?? dirname(artifactPath);
    return { root, activeMs: this.projectActivity(root) };
  }

  private list(dir: string): string[] {
    let names = this.listings.get(dir);
    if (names === undefined) {
      try {
        names = readdirSync(dir).slice(0, MAX_ROOT_ENTRIES);
      } catch {
        names = [];
      }
      this.listings.set(dir, names);
    }
    return names;
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
      if (this.list(dir).some((name) => MARKER_SET.has(name))) {
        found = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const seen of visited) this.roots.set(seen, found);
    return found;
  }

  private projectActivity(root: string): number | undefined {
    if (this.activity.has(root)) return this.activity.get(root);
    let newest: number | undefined;
    const consider = (value: number | undefined) => {
      // A clock-skewed future mtime must not make a project look busy forever.
      if (value === undefined || value > this.now + 60_000) return;
      if (newest === undefined || value > newest) newest = value;
    };
    // An unreadable root lists nothing: only git can speak for it.
    for (const name of this.list(root)) {
      const path = join(root, name);
      if (IGNORED.has(name) || this.exclude.has(path)) continue;
      consider(mtimeMs(path));
    }
    consider(this.gitActivity(root));
    this.activity.set(root, newest);
    return newest;
  }

  /** Index and HEAD reflog mtimes of the repository containing `root`. */
  private gitActivity(root: string): number | undefined {
    let dir = root;
    for (;;) {
      if (this.repos.has(dir)) return this.repos.get(dir);
      const git = gitDir(dir);
      if (git) {
        let newest: number | undefined;
        for (const file of ["index", join("logs", "HEAD"), "HEAD", "FETCH_HEAD"]) {
          try {
            const value = statSync(join(git, file)).mtimeMs;
            if (newest === undefined || value > newest) newest = value;
          } catch {
            /* absent in this repository */
          }
        }
        this.repos.set(dir, newest);
        return newest;
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
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
