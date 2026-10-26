import { type Dirent, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Where `ctrl-o` can take a session next. Suggestions only: whatever the user
 * picks goes back through the host's target guardrails and config resolution,
 * exactly as if it had been typed on the command line.
 */
export type JumpSource = "typed" | "cleaned" | "up" | "inside" | "beside";

export interface JumpTarget {
  path: string;
  source: JumpSource;
  /** Short, display-only detail: "cleaned 3d ago", "git · node". */
  detail?: string;
}

export interface RecentClean {
  targetDir: string;
  ts: string;
  bytesFreed: number;
}

/** Marker files that say "a project lives here" - read with one readdir. */
const PROJECT_MARKERS: ReadonlyArray<readonly [file: string, label: string]> = [
  [".git", "git"],
  ["package.json", "node"],
  ["Cargo.toml", "rust"],
  ["go.mod", "go"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["Gemfile", "ruby"],
  ["composer.json", "php"],
  ["pom.xml", "java"],
  ["build.gradle", "java"],
  ["build.gradle.kts", "java"],
  ["pubspec.yaml", "dart"],
  ["mix.exs", "elixir"],
  ["deno.json", "deno"],
];
/** Never offered as somewhere to go: build output, caches, VCS internals. */
const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
]);
const MAX_ENTRIES_PER_DIR = 400;
const MAX_TARGETS = 200;

function readDirs(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .slice(0, MAX_ENTRIES_PER_DIR)
      .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name));
  } catch {
    return [];
  }
}

/** "git · node" for a project folder; undefined for a plain one. */
export function projectKind(path: string): string | undefined {
  let names: Set<string>;
  try {
    names = new Set(readdirSync(path).slice(0, MAX_ENTRIES_PER_DIR));
  } catch {
    return undefined;
  }
  const labels = [
    ...new Set(PROJECT_MARKERS.filter(([file]) => names.has(file)).map(([, label]) => label)),
  ];
  return labels.length > 0 ? labels.slice(0, 2).join(" · ") : undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function ago(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "recently";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 60 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`;
}

/**
 * Bounded, synchronous discovery: one readdir per folder looked at, a few
 * hundred folders at most. Order is the reading order of the empty query -
 * up one level, places you cleaned before, projects inside, projects beside.
 */
export function discoverJumpTargets(
  targetDir: string,
  recent: readonly RecentClean[] = [],
  now = Date.now(),
  scratch = tmpdir(),
): JumpTarget[] {
  const seen = new Set<string>([targetDir]);
  const out: JumpTarget[] = [];
  const add = (target: JumpTarget) => {
    if (seen.has(target.path) || out.length >= MAX_TARGETS) return;
    seen.add(target.path);
    out.push(target);
  };

  const parent = dirname(targetDir);
  if (parent !== targetDir) add({ path: parent, source: "up" });

  const temporary = resolve(scratch);
  for (const entry of recent) {
    if (!isAbsolute(entry.targetDir) || seen.has(entry.targetDir)) continue;
    // A scratch folder cleaned once is not somewhere anyone goes back to.
    if (entry.targetDir === temporary || entry.targetDir.startsWith(`${temporary}${sep}`)) continue;
    if (!isDirectory(entry.targetDir)) continue;
    add({ path: entry.targetDir, source: "cleaned", detail: `cleaned ${ago(entry.ts, now)}` });
  }

  // Inside: two levels, projects only - a monorepo's apps/* and packages/*.
  const inside: JumpTarget[] = [];
  for (const child of readDirs(targetDir)) {
    const path = join(targetDir, child.name);
    const kind = projectKind(path);
    if (kind) inside.push({ path, source: "inside", detail: kind });
    else if (!child.name.startsWith(".")) {
      for (const grandchild of readDirs(path)) {
        const nested = join(path, grandchild.name);
        const nestedKind = projectKind(nested);
        if (nestedKind) inside.push({ path: nested, source: "inside", detail: nestedKind });
      }
    }
  }
  for (const target of inside.sort((a, b) => a.path.localeCompare(b.path))) add(target);

  // Beside: siblings of the target, projects first.
  if (parent !== targetDir) {
    const beside = readDirs(parent)
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        const path = join(parent, entry.name);
        const kind = projectKind(path);
        return { path, source: "beside" as const, ...(kind ? { detail: kind } : {}) };
      })
      .sort(
        (a, b) =>
          Number(Boolean(b.detail)) - Number(Boolean(a.detail)) || a.path.localeCompare(b.path),
      );
    for (const target of beside) add(target);
  }
  return out;
}

/** `~/x` for display; the real path is always what gets used. */
export function tildePath(path: string, home = homedir()): string {
  if (home && path === home) return "~";
  if (home && path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * How a target reads in the list, relative to where the review is now:
 * `./apps/web` inside, `../api` beside, `~/…` for anything further away.
 * Fuzzy matching runs on this label, so what you see is what you type.
 */
export function jumpLabel(target: JumpTarget, targetDir: string, home = homedir()): string {
  if (target.source === "inside") {
    return `.${sep}${relative(targetDir, target.path)}`;
  }
  if (target.source === "beside") return `..${sep}${basename(target.path)}`;
  return tildePath(target.path, home);
}

/** A query that reads as a path ("/", "~", ".", "..") resolved against the target. */
export function typedPath(query: string, targetDir: string, home = homedir()): string | null {
  const trimmed = query.trim();
  if (!/^(?:[/\\~]|\.{1,2}(?:[/\\]|$)|[A-Za-z]:[/\\])/.test(trimmed)) return null;
  const expanded =
    trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
  return resolve(targetDir, expanded);
}

/**
 * fzf-flavoured subsequence score: every query character must appear in
 * order. Matches that start a path segment, continue a run or land in the
 * folder's own name score higher; shorter paths win ties. Null = no match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLocaleLowerCase().replace(/\s+/g, "");
  if (q.length === 0) return 0;
  const lower = text.toLocaleLowerCase();
  const nameStart = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf("\\")) + 1;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of q) {
    const at = lower.indexOf(char, from);
    if (at < 0) return null;
    const boundary = at === 0 || "/\\-_. ".includes(lower[at - 1] ?? "");
    score += 1;
    if (boundary) score += 8;
    if (at === previous + 1) score += 5;
    if (at >= nameStart) score += 3;
    previous = at;
    from = at + 1;
  }
  return score * 100 - text.length;
}

/** Rank targets for a query; the empty query keeps discovery order. */
export function rankJumpTargets(
  targets: readonly JumpTarget[],
  query: string,
  targetDir: string,
): JumpTarget[] {
  const typed = typedPath(query, targetDir);
  if (typed !== null) {
    // A typed path is taken literally, then completed from what is around it.
    const exact =
      isDirectory(typed) && typed !== targetDir ? [{ path: typed, source: "typed" as const }] : [];
    const parent = isDirectory(typed) ? typed : dirname(typed);
    const prefix = basename(typed).toLocaleLowerCase();
    const completions = (isDirectory(typed) ? readDirs(typed) : readDirs(parent))
      .filter((entry) => isDirectory(typed) || entry.name.toLocaleLowerCase().startsWith(prefix))
      .slice(0, 50)
      .map((entry) => ({ path: join(parent, entry.name), source: "typed" as const }));
    return [...exact, ...completions].filter((target) => target.path !== targetDir);
  }
  if (query.trim() === "") return [...targets];
  return targets
    .map((target) => ({ target, score: fuzzyScore(query, jumpLabel(target, targetDir)) }))
    .filter((row): row is { target: JumpTarget; score: number } => row.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.target);
}
