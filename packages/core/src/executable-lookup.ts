import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Native shell-free executable suffixes on Windows.
 *
 * `spawnSync` / `spawn` without `shell: true` invokes libuv's `CreateProcessW`
 * path, which can execute only native Win32 binaries (`.com`, `.exe`) directly
 * and rejects `.cmd`/`.bat` shims (`EINVAL`). Honor `PATHEXT` ordering while
 * restricting to native shell-free suffixes so a `.CMD` shim ahead of a real
 * `.exe` on `PATH` does not shadow the working binary.
 */
const WINDOWS_NATIVE_EXTENSIONS = new Set([".exe", ".com"]);

export function windowsShellFreeExtensions(
  pathext: string | undefined = process.env.PATHEXT,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of (pathext ?? ".COM;.EXE").split(";")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = (trimmed.startsWith(".") ? trimmed : `.${trimmed}`).toLowerCase();
    if (!WINDOWS_NATIVE_EXTENSIONS.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered.length > 0 ? ordered : [".exe", ".com"];
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isPosixExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function stripOuterQuotes(entry: string): string {
  return entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')
    ? entry.slice(1, -1)
    : entry;
}

export function isExplicitBinaryPath(
  binary: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    return binary.includes("/") || binary.includes("\\") || /^[A-Za-z]:/.test(binary);
  }
  return binary.includes("/");
}

/**
 * Only accept absolute directory entries from `PATH`.
 *
 * Skips empty, whitespace-only, `.`, and relative segments on every platform
 * (including drive-relative and root-relative entries on Windows) so searching
 * `PATH` never inspects the current working directory. Literal spaces inside an
 * absolute directory name (such as `/opt/my tools`) are preserved.
 */
export function isAbsolutePathEntry(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (dir.trim().length === 0) return false;
  if (platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(dir) || /^(?:\\\\|\/\/)[^\\/]/.test(dir);
  }
  return posix.isAbsolute(dir);
}

export interface PathLookupOptions {
  platform?: NodeJS.Platform;
  pathEnv?: string | undefined;
  pathextEnv?: string | undefined;
  cwd?: string;
  isFile?: (candidate: string) => boolean;
  isExecutable?: (candidate: string) => boolean;
}

export interface PathLookupResult {
  resolvedPath?: string;
  /** Non-executable regular file seen on an absolute POSIX PATH dir when no executable entry matched. */
  nonExecutablePath?: string;
}

/**
 * Resolve an executable binary to an absolute file path for shell-free spawn:
 * - For explicit paths (containing a path separator or Windows drive), resolves
 *   against `cwd` and applies shell-free `PATHEXT` suffixes on Windows.
 * - For bare command names, searches only absolute `PATH` directories (skipping
 *   empty, whitespace-only, `.`, and relative segments on every platform) while
 *   preserving literal spaces inside absolute directory names.
 * - On POSIX: skips non-executable regular files and continues searching `PATH`.
 * - On Windows: applies native shell-free `PATHEXT` suffixes (`.com`/`.exe`),
 *   skipping `.cmd`/`.bat` shims that cannot run without a shell.
 */
export function lookupExecutable(
  binary: string,
  options: PathLookupOptions = {},
): PathLookupResult {
  const platform = options.platform ?? process.platform;
  const pathMod = platform === "win32" ? win32 : posix;
  const cwd = options.cwd ?? process.cwd();
  const checkFile = options.isFile ?? isRegularFile;
  const checkExec =
    options.isExecutable ?? (platform === "win32" ? checkFile : isPosixExecutableFile);
  const pathDelimiter = platform === "win32" ? ";" : ":";

  if (isExplicitBinaryPath(binary, platform)) {
    const abs = pathMod.resolve(cwd, binary);
    if (checkFile(abs)) return { resolvedPath: abs };
    if (platform === "win32" && pathMod.extname(abs) === "") {
      for (const ext of windowsShellFreeExtensions(options.pathextEnv)) {
        const candidate = abs + ext;
        if (checkFile(candidate)) return { resolvedPath: candidate };
      }
    }
    return {};
  }

  const rawPath = "pathEnv" in options ? options.pathEnv : process.env.PATH;
  if (rawPath === undefined) return {};

  const entries = rawPath.split(pathDelimiter);
  if (platform === "win32") {
    const hasExt = pathMod.extname(binary) !== "";
    const suffixes = hasExt ? [""] : windowsShellFreeExtensions(options.pathextEnv);
    for (const rawDir of entries) {
      const dir = stripOuterQuotes(rawDir);
      if (!isAbsolutePathEntry(dir, "win32")) continue;
      for (const ext of suffixes) {
        const candidate = pathMod.join(dir, binary + ext);
        if (checkFile(candidate)) return { resolvedPath: candidate };
      }
    }
    return {};
  }

  let nonExecutablePath: string | undefined;
  for (const rawDir of entries) {
    if (!isAbsolutePathEntry(rawDir, platform)) continue;
    const candidate = pathMod.join(rawDir, binary);
    if (checkExec(candidate)) {
      return { resolvedPath: candidate };
    }
    if (!nonExecutablePath && checkFile(candidate)) {
      nonExecutablePath = candidate;
    }
  }
  return nonExecutablePath ? { nonExecutablePath } : {};
}
