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
import { basename, dirname, join, normalize } from "node:path";
import type { ScanEntry } from "@kitsunekode/sweep-protocol";
import { type CatalogEntry, defaultCatalogEntryForName } from "./catalog.js";
import { stripWindowsVerbatimPrefix } from "./guardrails.js";

export type ArtifactContextReason = "entry-type-mismatch" | "tool-home" | "no-project-marker";

/** Non-blocking informational reason for candidates inside cloud-synced folders. */
export const CLOUD_SYNC_REASON = "cloud-sync";

/**
 * Home-relative directories owned by toolchains, package managers, editors,
 * and desktop apps. Their `node_modules`/`target` trees are runtime state
 * (global installs, editor servers, prebuilt plugin binaries), not project
 * output.
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
  ["go", "pkg"],
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
  [".t3", "userdata"],
  ["Applications"],
  ["Library"],
  ["AppData"],
];

/** Carve-outs inside tool dirs: OS temp space and agent worktrees host ordinary projects. */
const HOME_TOOL_EXCEPTIONS: readonly (readonly string[])[] = [
  ["AppData", "Local", "Temp"],
  [".codex", "worktrees"],
];

/**
 * System install locations and OS trees matched across platforms (after
 * stripping a Windows drive letter, when present). `/var` is listed by
 * subdirectory: `/var/www` holds user projects and macOS `/var/folders` is the
 * per-user temp root.
 */
const SYSTEM_TOOL_DIRS: readonly (readonly string[])[] = [
  ["usr"],
  ["opt"],
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

/**
 * Unix-only OS roots. Applied only to paths without a Windows drive letter or
 * UNC prefix so Windows project roots such as `C:\dev\...` or `D:\bin\...` are
 * not demoted as tool homes. `/run` is omitted so `/run/media/<user>/<drive>`
 * and `/run/user/<uid>/gvfs` mounts stay cleanable.
 */
const UNIX_SYSTEM_TOOL_DIRS: readonly (readonly string[])[] = [
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
];

/** Carve-outs inside `UNIX_SYSTEM_TOOL_DIRS` (e.g. Linux `/dev/shm` tmpfs). */
const UNIX_SYSTEM_TOOL_EXCEPTIONS: readonly (readonly string[])[] = [["dev", "shm"]];

/**
 * Home-relative cloud-synced folders. Candidates inside them stay at their
 * normal tier and selection, and carry the non-blocking `cloud-sync` reason.
 */
const CLOUD_SYNC_HOME_DIRS: readonly (readonly string[])[] = [
  ["Dropbox"],
  ["OneDrive"],
  ["Google Drive"],
  ["My Drive"],
  ["Library", "CloudStorage"],
];

/** Home-relative first-segment prefixes for org-named cloud-sync folders. */
const CLOUD_SYNC_HOME_PREFIXES: readonly string[] = ["OneDrive - "];

type PathPrefixKind = "none" | "drive" | "unc";

function foldSegment(segment: string, caseFold: boolean): string {
  return caseFold ? segment.toLowerCase() : segment;
}

function normalizeSegments(rest: string, splitOnBackslash: boolean, caseFold: boolean): string[] {
  const out: string[] = [];
  for (const part of rest.split(splitOnBackslash ? /[\\/]/ : "/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(foldSegment(part, caseFold));
  }
  return out;
}

function splitPathSegments(
  path: string,
  isWindows: boolean,
  caseFold: boolean,
): { segments: string[]; prefixKind: PathPrefixKind } {
  const cleaned = stripWindowsVerbatimPrefix(path, isWindows);
  if (isWindows) {
    const uncMatch = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/.exec(cleaned);
    if (uncMatch) {
      const prefix = foldSegment(`\\\\${uncMatch[1]}\\${uncMatch[2]}`, caseFold);
      return {
        segments: [prefix, ...normalizeSegments(uncMatch[3] ?? "", true, caseFold)],
        prefixKind: "unc",
      };
    }
    const driveMatch = /^([a-zA-Z]:)(?:[\\/](.*))?$/.exec(cleaned);
    if (driveMatch) {
      const drive = foldSegment(driveMatch[1]!, caseFold);
      return {
        segments: [drive, ...normalizeSegments(driveMatch[2] ?? "", true, caseFold)],
        prefixKind: "drive",
      };
    }
    return { segments: normalizeSegments(cleaned, true, caseFold), prefixKind: "none" };
  }
  return { segments: normalizeSegments(cleaned, false, caseFold), prefixKind: "none" };
}

function startsWithSegments(
  segments: readonly string[],
  prefix: readonly string[],
  caseFold: boolean,
): boolean {
  return (
    prefix.length <= segments.length &&
    prefix.every((part, i) => segments[i] === foldSegment(part, caseFold))
  );
}

function segmentsBelowHome(
  segments: readonly string[],
  home: string,
  isWindows: boolean,
  caseFold: boolean,
): readonly string[] | null {
  const parsedHome = splitPathSegments(home, isWindows, caseFold);
  const minHomeSegments = parsedHome.prefixKind === "none" ? 1 : 2;
  if (parsedHome.segments.length < minHomeSegments) return null;
  if (
    parsedHome.segments.length > segments.length ||
    !parsedHome.segments.every((part, i) => segments[i] === part)
  ) {
    return null;
  }
  return segments.slice(parsedHome.segments.length);
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
 * Platform-parameterized core of `isInsideToolHome` so Windows drive/UNC and
 * POSIX rules can be verified deterministically on every host OS.
 */
export function isInsideToolHomeFor(
  path: string,
  home: string,
  isWindows: boolean,
  isMacOs: boolean,
): boolean {
  const caseFold = isWindows || isMacOs;
  const { segments, prefixKind } = splitPathSegments(path, isWindows, caseFold);

  if (prefixKind === "none") {
    if (SYSTEM_TOOL_DIRS.some((prefix) => startsWithSegments(segments, prefix, caseFold))) {
      return true;
    }
    if (
      !UNIX_SYSTEM_TOOL_EXCEPTIONS.some((prefix) =>
        startsWithSegments(segments, prefix, caseFold),
      ) &&
      UNIX_SYSTEM_TOOL_DIRS.some((prefix) => startsWithSegments(segments, prefix, caseFold))
    ) {
      return true;
    }
  } else if (prefixKind === "drive") {
    const rooted = segments.slice(1);
    if (SYSTEM_TOOL_DIRS.some((prefix) => startsWithSegments(rooted, prefix, caseFold))) {
      return true;
    }
  }

  const below = segmentsBelowHome(segments, home, isWindows, caseFold);
  if (
    below &&
    !HOME_TOOL_EXCEPTIONS.some((prefix) => startsWithSegments(below, prefix, caseFold)) &&
    HOME_TOOL_DIRS.some((prefix) => startsWithSegments(below, prefix, caseFold))
  ) {
    return true;
  }

  return isMacOs && hasMacOsAppBundleAncestor(path);
}

/**
 * True when `path` lies inside a toolchain, package-manager, editor or system
 * install tree, or (on macOS) inside a real `.app` bundle containing
 * `Contents/Info.plist`. `home` is injectable for tests; a home with no
 * segments (unset or `/`) disables home rules.
 */
export function isInsideToolHome(path: string, home: string = homedir()): boolean {
  return isInsideToolHomeFor(
    path,
    home,
    process.platform === "win32",
    process.platform === "darwin",
  );
}

/**
 * Platform-parameterized core of `isInsideCloudSyncDir`.
 */
export function isInsideCloudSyncDirFor(
  path: string,
  home: string,
  isWindows: boolean,
  isMacOs: boolean,
): boolean {
  const caseFold = isWindows || isMacOs;
  const { segments } = splitPathSegments(path, isWindows, caseFold);
  const below = segmentsBelowHome(segments, home, isWindows, caseFold);
  if (!below || below.length === 0) return false;

  if (
    CLOUD_SYNC_HOME_DIRS.some(
      (prefix) => below.length > prefix.length && startsWithSegments(below, prefix, caseFold),
    )
  ) {
    return true;
  }

  const first = below[0]!;
  return (
    below.length > 1 &&
    CLOUD_SYNC_HOME_PREFIXES.some((prefix) => {
      const folded = foldSegment(prefix, caseFold);
      return first.startsWith(folded) && first.length > folded.length;
    })
  );
}

/**
 * True when `path` lies inside a cloud-synced folder under `home` (`~/Dropbox`,
 * `~/OneDrive`, `~/OneDrive - <Org>`, `~/Google Drive`, `~/My Drive`, or macOS
 * `~/Library/CloudStorage/*`). Informational only: does not change risk tier or
 * default selection.
 */
export function isInsideCloudSyncDir(path: string, home: string = homedir()): boolean {
  return isInsideCloudSyncDirFor(
    path,
    home,
    process.platform === "win32",
    process.platform === "darwin",
  );
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
