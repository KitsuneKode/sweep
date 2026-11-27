/**
 * Context checks that decide whether a default-catalog name is really the
 * build artifact it looks like. A matching name alone is not enough: a regular
 * file called `target`, an authored `notes/target/` folder, or a
 * `node_modules` inside a package manager's own install tree all match the
 * catalog and must not be presumed safe. Rust parity: `sweep-engine`
 * `artifact_context_reason` applies the same rules in the same order.
 */
import { lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, sep } from "node:path";
import type { ScanEntry } from "@kitsunekode/sweep-protocol";
import { type CatalogEntry, defaultCatalogEntryForName } from "./catalog.js";
import { stripWindowsVerbatimPrefix } from "./guardrails.js";

export type ArtifactContextReason = "entry-type-mismatch" | "tool-home" | "no-project-marker";

const CASE_FOLD = process.platform === "darwin" || process.platform === "win32";

/**
 * Home-relative directories owned by toolchains, package managers, editors,
 * desktop apps, and cloud-synced storage. Their `node_modules`/`target` trees
 * are runtime state (global installs, editor servers, prebuilt plugin
 * binaries), not project output.
 */
const HOME_TOOL_DIRS: readonly (readonly string[])[] = [
  [".bun"],
  [".cargo"],
  [".rustup"],
  [".npm"],
  [".npm-global"],
  [".nvm"],
  [".nodenv"],
  [".yarn"],
  [".volta"],
  [".fnm"],
  [".deno"],
  [".pnpm-store"],
  [".mise"],
  [".asdf"],
  [".pyenv"],
  [".poetry"],
  [".conda"],
  ["miniconda3"],
  ["anaconda3"],
  ["miniforge3"],
  ["mambaforge"],
  [".uv"],
  [".pipx"],
  [".rbenv"],
  [".rvm"],
  [".gem"],
  ["go"],
  [".sdkman"],
  [".gradle"],
  [".m2"],
  [".composer"],
  [".pub-cache"],
  [".android"],
  [".flutter"],
  [".local"],
  [".config"],
  [".cache"],
  [".var", "app"],
  ["snap"],
  ["scoop"],
  [".vscode"],
  [".vscode-insiders"],
  [".vscode-oss"],
  [".vscode-server"],
  [".cursor"],
  [".cursor-server"],
  [".windsurf"],
  [".windsurf-server"],
  [".zed"],
  [".claude"],
  [".codex"],
  [".gemini"],
  [".t3"],
  ["Applications"],
  ["Library"],
  ["AppData"],
  ["Dropbox"],
  ["OneDrive"],
];

/** Carve-outs inside tool dirs: OS temp space hosts ordinary scratch projects. */
const HOME_TOOL_EXCEPTIONS: readonly (readonly string[])[] = [["AppData", "Local", "Temp"]];

/**
 * System install locations and OS trees. `/var` is listed by subdirectory:
 * `/var/www` holds user projects and macOS `/var/folders` is the per-user temp
 * root.
 */
const SYSTEM_TOOL_DIRS: readonly (readonly string[])[] = [
  ["usr"],
  ["opt"],
  ["etc"],
  ["private", "etc"],
  ["sys"],
  ["proc"],
  ["dev"],
  ["boot"],
  ["bin"],
  ["sbin"],
  ["lib"],
  ["lib64"],
  ["run"],
  ["snap"],
  ["nix"],
  ["home", "linuxbrew", ".linuxbrew"],
  ["var", "lib"],
  ["var", "cache"],
  ["var", "opt"],
  ["var", "db"],
  ["private", "var", "db"],
  ["Applications"],
  ["System"],
  ["Library"],
  ["Windows"],
  ["Program Files"],
  ["Program Files (x86)"],
  ["ProgramData"],
];

function segmentsOf(path: string): string[] {
  const segments = normalize(stripWindowsVerbatimPrefix(path))
    .split(sep === "\\" ? /[\\/]/ : sep)
    .filter((segment) => segment !== "");
  return CASE_FOLD ? segments.map((segment) => segment.toLowerCase()) : segments;
}

function fold(prefix: readonly string[]): string[] {
  return CASE_FOLD ? prefix.map((segment) => segment.toLowerCase()) : [...prefix];
}

function startsWithSegments(segments: readonly string[], prefix: readonly string[]): boolean {
  const folded = fold(prefix);
  return folded.length <= segments.length && folded.every((part, i) => segments[i] === part);
}

/** Drop a Windows drive (`c:`) so system prefixes compare on every drive. */
function withoutDrive(segments: string[]): string[] {
  return segments.length > 0 && /^[a-z]:$/i.test(segments[0] ?? "") ? segments.slice(1) : segments;
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/**
 * True when an ancestor directory of `path` is a macOS application bundle
 * (`*.app` with a `Contents/Info.plist` file). Ordinary project folders named
 * like `example.app` lack `Contents/Info.plist` and are not treated as bundles.
 */
export function hasMacOsAppBundleAncestor(path: string): boolean {
  let current = dirname(normalize(path));
  while (true) {
    if (
      basename(current).toLowerCase().endsWith(".app") &&
      isExistingFile(join(current, "Contents", "Info.plist"))
    ) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * True when `path` lies inside a toolchain, package-manager, editor or system
 * install tree, or (on macOS) inside a real `.app` bundle containing
 * `Contents/Info.plist`. `home` is injectable for tests; a home with no
 * segments (unset or `/`) disables home rules.
 */
export function isInsideToolHome(path: string, home: string = homedir()): boolean {
  const segments = segmentsOf(path);

  const rooted = withoutDrive(segments);
  if (SYSTEM_TOOL_DIRS.some((prefix) => startsWithSegments(rooted, prefix))) return true;

  const homeSegments = segmentsOf(home);
  if (homeSegments.length > 0 && startsWithSegments(segments, homeSegments)) {
    const below = segments.slice(homeSegments.length);
    if (
      !HOME_TOOL_EXCEPTIONS.some((prefix) => startsWithSegments(below, prefix)) &&
      HOME_TOOL_DIRS.some((prefix) => startsWithSegments(below, prefix))
    ) {
      return true;
    }
  }

  return process.platform === "darwin" && hasMacOsAppBundleAncestor(path);
}

function isRegularFile(path: string): boolean {
  try {
    // lstat, not stat: a symlink named Cargo.toml or CACHEDIR.TAG is not the
    // manifest or tag cargo wrote, and must not promote an authored tree.
    const stat = lstatSync(path, { throwIfNoEntry: false });
    return stat?.isFile() === true && stat.isSymbolicLink() === false;
  } catch {
    // Unreadable evidence is missing evidence.
    return false;
  }
}

/** True when the catalog entry needs no marker or one of its markers exists. */
export function hasProjectMarker(entryPath: string, entry: CatalogEntry): boolean {
  if (!entry.markers) return true;
  const parent = dirname(entryPath);
  return (
    entry.markers.siblings.some((name) => isRegularFile(join(parent, name))) ||
    entry.markers.inside.some((name) => isRegularFile(join(entryPath, name)))
  );
}

/**
 * Why a default-catalog match is not the artifact it appears to be, or `null`
 * when it is. Callers handle VCS, symlink and non-default names first. Checks
 * run cheapest first; marker I/O happens only for names that declare markers.
 */
export function artifactContextReason(
  entry: Pick<ScanEntry, "path" | "name" | "entryType">,
  home?: string,
): ArtifactContextReason | null {
  const catalogEntry = defaultCatalogEntryForName(entry.name);
  if (!catalogEntry) return null;
  if (catalogEntry.entryType && entry.entryType !== catalogEntry.entryType) {
    return "entry-type-mismatch";
  }
  if (isInsideToolHome(entry.path, home)) return "tool-home";
  if (!hasProjectMarker(entry.path, catalogEntry)) return "no-project-marker";
  return null;
}
