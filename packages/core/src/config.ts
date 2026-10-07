import {
  existsSync,
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve } from "node:path";
import type { SweepConfig } from "@kitsunekode/sweep-protocol";
import { globMatch } from "./glob-match.js";
import { assertSafePattern } from "./guardrails.js";

export class ConfigParseError extends Error {
  readonly code = 3;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigParseError";
  }
}

// The default pattern set lives in the curated catalog - only machine-created,
// ecosystem-canonical names ship enabled (node_modules, .next, target).
// Generic names like build/dist/out stay opt-in: they can hold authored files.
export { DEFAULT_PATTERN_SET, DEFAULT_PATTERNS } from "./catalog.js";
import { DEFAULT_PATTERNS } from "./catalog.js";

export const DEFAULT_CONFIG: SweepConfig = {
  patterns: DEFAULT_PATTERNS,
  // Trash dirs created by `sweep --trash` must never be re-selected -
  // they hold live restore data until the user purges them.
  ignore: [".sweep-trash-*"],
  maxSizeGB: null,
  depth: -1,
};

/** Starter `.sweeprc` scaffold written by `sweep init`. */
export const INIT_SWEEPRC_TEMPLATE = {
  patterns: [".custom-output"],
  ignore: ["packages/vendor-patched"],
  maxSizeGB: null,
  depth: -1,
} as const;

const CONFIG_FIELD_TYPES = {
  patterns: "string[]",
  disabledPatterns: "string[]",
  ignore: "string[]",
  maxSizeGB: "number",
  depth: "number",
} as const;

type ConfigField = keyof typeof CONFIG_FIELD_TYPES;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// ─── Config file reading ──────────────────────────────────────────────────────

/**
 * Config files are single-purpose JSON, so a sane bound is far below anything
 * legitimate. The lstat check keeps a hostile FIFO/device named `.sweeprc`
 * from blocking readFileSync forever or feeding an endless stream to JSON.parse.
 */
const MAX_CONFIG_BYTES = 1024 * 1024;

/** Throws a ConfigParseError when the path is not a bounded regular file. */
function assertReadableConfigFile(filePath: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigParseError(`Failed to read config at ${filePath}: ${msg}`, { cause: err });
  }
  if (!stat.isFile()) {
    throw new ConfigParseError(`Config at ${filePath} is not a regular file`);
  }
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new ConfigParseError(
      `Config at ${filePath} exceeds ${MAX_CONFIG_BYTES / 1024} KB (${stat.size} bytes)`,
    );
  }
}

/** Pin the opened regular file and bound reads even if it grows after fstat. */
function readConfigText(filePath: string, requireOwned = false): string {
  assertReadableConfigFile(filePath);
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ConfigParseError(`Config at ${filePath} is not a regular file`);
    if (
      requireOwned &&
      process.platform !== "win32" &&
      process.getuid &&
      stat.uid !== process.getuid()
    ) {
      throw new ConfigParseError(
        `Automatically discovered config at ${filePath} is owned by another user; review it and use --config explicitly if trusted`,
      );
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_CONFIG_BYTES + 1 - bytes));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      bytes += count;
      if (bytes > MAX_CONFIG_BYTES)
        throw new ConfigParseError(`Config at ${filePath} exceeds ${MAX_CONFIG_BYTES / 1024} KB`);
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readJsonConfig(filePath: string, requireOwned = false): Partial<SweepConfig> | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readConfigText(filePath, requireOwned);
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigParseError(`Config at ${filePath} must be a JSON object`);
    }
    for (const key of Object.keys(parsed)) {
      if (!Object.hasOwn(CONFIG_FIELD_TYPES, key)) {
        throw new ConfigParseError(`Config at ${filePath} has unknown field "${key}"`);
      }
    }
    return parsed as Partial<SweepConfig>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigParseError(`Failed to parse config at ${filePath}: ${msg}`, { cause: err });
  }
}

/**
 * Walk up from startDir, looking for .sweeprc (JSON format, no extension).
 * Returns the first one found (closest to CWD wins), or null.
 */
export function findProjectConfigPath(startDir: string): string | null {
  let dir = resolve(startDir);
  const fsRoot = parse(dir).root;

  while (true) {
    const candidate = join(dir, ".sweeprc");
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dir === fsRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break; // safety: already at root
    dir = parent;
  }
  return null;
}

function findProjectConfig(startDir: string): Partial<SweepConfig> | null {
  const configPath = findProjectConfigPath(startDir);
  if (!configPath) return null;
  return readJsonConfig(configPath, true);
}

export type ConfigValidationResult =
  | { ok: true; path: string }
  | { ok: false; path: string; detail: string };

/**
 * Validate a `.sweeprc` file without applying CLI overrides.
 * Checks JSON shape, known fields, and pattern safety via loadConfig.
 */
export function validateProjectConfigFile(configPath: string, cwd: string): ConfigValidationResult {
  if (!existsSync(configPath)) {
    return { ok: false, path: configPath, detail: "file not found" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readConfigText(configPath));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path: configPath, detail: `invalid JSON: ${msg}` };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, path: configPath, detail: "config must be a JSON object" };
  }

  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in CONFIG_FIELD_TYPES)) {
      return { ok: false, path: configPath, detail: `unknown field "${key}"` };
    }
  }

  for (const [field, expectedType] of Object.entries(CONFIG_FIELD_TYPES) as Array<
    [ConfigField, (typeof CONFIG_FIELD_TYPES)[ConfigField]]
  >) {
    const value = obj[field];
    if (value === undefined) continue;
    if (expectedType === "string[]" && !isStringArray(value)) {
      return { ok: false, path: configPath, detail: `"${field}" must be a string array` };
    }
    if (
      expectedType === "number" &&
      typeof value !== "number" &&
      !(field === "maxSizeGB" && value === null)
    ) {
      return { ok: false, path: configPath, detail: `"${field}" must be a number` };
    }
  }

  try {
    loadConfig(cwd, configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path: configPath, detail: msg };
  }

  return { ok: true, path: configPath };
}

export function writeInitSweeprc(configPath: string, force = false): "created" | "exists" {
  // lstat before existsSync: a symlinked .sweeprc (possibly dangling) would
  // make writeFileSync follow the link and overwrite whatever it points at.
  try {
    const stat = lstatSync(configPath);
    if (stat.isSymbolicLink()) {
      throw new ConfigParseError(
        `${configPath} is a symlink - refusing to write through it. Remove it first.`,
      );
    }
    if (!force) return "exists";
  } catch (err) {
    if (err instanceof ConfigParseError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // ENOENT - nothing there, safe to create.
  }

  writeFileSync(configPath, `${JSON.stringify(INIT_SWEEPRC_TEMPLATE, null, 2)}\n`, "utf-8");
  return "created";
}

/**
 * What the TUI pattern pane writes into a project `.sweeprc`: the delta from
 * built-in defaults, not the whole resolved config. Extra (opt-in + custom)
 * patterns go under `patterns`; defaults the user switched off go under
 * `disabledPatterns`. Scalar fields are left to `sweep init` - the pane only
 * owns the pattern list it edited.
 */
export interface ProjectSweeprcDelta {
  patterns: string[];
  disabledPatterns: string[];
}

/**
 * Write a project `.sweeprc` holding the pattern delta.
 *
 * Safety contract - same as writeInitSweeprc, plus no-clobber by default:
 * - refuses to write through a symlink (dangling included),
 * - returns "exists" unless `force` is passed (the TUI asks first),
 * - writes to a sibling temp file then renames, so a crash mid-write never
 *   leaves a torn config,
 * - read-modify-write on overwrite: the pane only owns `patterns` and
 *   `disabledPatterns`, so an existing file's `ignore`, `maxSizeGB`, `depth`,
 *   or unrecognized fields are preserved verbatim instead of silently
 *   reverting to defaults. An unparseable existing file refuses to be
 *   clobbered - nothing silently resets a guardrail.
 */
export function writeProjectSweeprc(
  configPath: string,
  delta: ProjectSweeprcDelta,
  force = false,
): "created" | "exists" | "updated" {
  let existed = false;
  try {
    const stat = lstatSync(configPath);
    if (stat.isSymbolicLink()) {
      throw new ConfigParseError(
        `${configPath} is a symlink - refusing to write through it. Remove it first.`,
      );
    }
    existed = true;
    if (!force) return "exists";
  } catch (err) {
    if (err instanceof ConfigParseError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // ENOENT - nothing there, safe to create.
  }

  // Start from whatever the existing file holds so overwrite only ever
  // replaces the two fields the pattern editor owns.
  const doc: Record<string, unknown> = {};
  if (existed) {
    let raw: unknown;
    try {
      raw = JSON.parse(readConfigText(configPath));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConfigParseError(
        `Refusing to overwrite ${configPath}: existing config is not parseable (${msg})`,
        { cause: err },
      );
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ConfigParseError(
        `Refusing to overwrite ${configPath}: existing config must be a JSON object`,
      );
    }
    Object.assign(doc, raw);
  }

  // Delta fields: absent means "use defaults", so an empty edited set removes
  // the key entirely rather than persisting a misleading empty array.
  const patterns = [...new Set(delta.patterns)].sort();
  const disabledPatterns = [...new Set(delta.disabledPatterns)].sort();
  if (patterns.length > 0) {
    doc.patterns = patterns;
  } else {
    delete doc.patterns;
  }
  if (disabledPatterns.length > 0) {
    doc.disabledPatterns = disabledPatterns;
  } else {
    delete doc.disabledPatterns;
  }

  // O_EXCL ("wx") on the temp path: a planted `.sweeprc.tmp-*` symlink fails
  // EEXIST instead of being written through. Retried suffixes keep a stray
  // leftover tmp file from wedging the write.
  let tmpPath = "";
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidatePath = `${configPath}.tmp-${process.pid}-${attempt}`;
    try {
      writeFileSync(candidatePath, `${JSON.stringify(doc, null, 2)}\n`, {
        encoding: "utf-8",
        flag: "wx",
      });
      tmpPath = candidatePath;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  if (!tmpPath) {
    throw new ConfigParseError(`could not create a temp file next to ${configPath}`);
  }
  try {
    renameSync(tmpPath, configPath);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Already renamed - nothing to clean.
    }
  }
  return existed ? "updated" : "created";
}

/**
 * Platform-resolved sweep config dir: $XDG_CONFIG_HOME/sweep,
 * %APPDATA%/sweep on Windows, else ~/.config/sweep.
 * `SWEEP_CONFIG_DIR` overrides everything - used by tests and dev runs so
 * they never touch the user's real config/history files.
 */
export function sweepConfigDir(): string {
  if (process.env.SWEEP_CONFIG_DIR) return process.env.SWEEP_CONFIG_DIR;
  const base =
    process.env.XDG_CONFIG_HOME ||
    (process.platform === "win32" && process.env.APPDATA
      ? process.env.APPDATA
      : join(homedir(), ".config"));
  return join(base, "sweep");
}

function getGlobalConfig(): Partial<SweepConfig> | null {
  return readJsonConfig(join(sweepConfigDir(), "config.json"), true);
}

// ─── Merge helpers ────────────────────────────────────────────────────────────

/** Concatenate and deduplicate string arrays, skipping undefined layers */
function mergeStringArrays(...sources: Array<string[] | undefined>): string[] {
  const all = sources.flatMap((s) => s ?? []);
  return [...new Set(all)];
}

/**
 * Config JSON is untyped - `{"patterns": {"x": 1}}` or `"patterns":
 * "node_modules"` must not reach flatMap/assertSafePattern and crash as a
 * TypeError (wrong exit taxonomy) or silently warp scan scope. Field type
 * errors are config-parse errors.
 */
function checkedStringArray(value: unknown, field: string, source: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ConfigParseError(`"${field}" in ${source} must be an array of strings`);
  }
  return value;
}

function subtractPatterns(patterns: string[], disabled: string[]): string[] {
  if (disabled.length === 0) return patterns;
  const disabledSet = new Set(disabled);
  return patterns.filter((pattern) => !disabledSet.has(pattern));
}

// ─── Ignore matching ──────────────────────────────────────────────────────────

/** Per-entry ignore check produced by compileIgnoreMatcher (targetDir pre-resolved). */
export type IgnoreMatcher = (entryPath: string, entryName: string) => boolean;

/**
 * Compile ignore patterns once per scan so the hot walk path avoids
 * re-resolving targetDir and re-scanning pattern strings for every entry.
 *
 * Returns null when there are no ignore rules - callers skip the check entirely.
 */
export function compileIgnoreMatcher(targetDir: string, ignore: string[]): IgnoreMatcher | null {
  if (ignore.length === 0) return null;

  const root = resolve(targetDir);
  const isCaseInsensitive = process.platform === "darwin" || process.platform === "win32";
  const exactNames = new Set<string>();
  const nameGlobs: string[] = [];
  const pathPrefixes: string[] = [];
  const pathGlobs: string[] = [];

  for (const raw of ignore) {
    const pattern = raw.replace(/\/+$/, "");
    if (pattern.length === 0) continue;
    const key = isCaseInsensitive ? pattern.toLowerCase() : pattern;
    if (pattern.includes("*") || pattern.includes("?")) {
      // `*`/`?` globs go through the linear matcher - same matching the scan
      // patterns use, so `?` means "one char" identically on both paths.
      if (pattern.includes("/")) {
        pathGlobs.push(key);
      } else {
        nameGlobs.push(key);
      }
    } else if (pattern.includes("/")) {
      pathPrefixes.push(key);
    } else {
      exactNames.add(key);
    }
  }

  return (entryPath, entryName) => {
    const nameKey = isCaseInsensitive ? entryName.toLowerCase() : entryName;
    if (exactNames.has(nameKey)) return true;
    if (nameGlobs.some((glob) => globMatch(glob, nameKey))) return true;
    if (pathPrefixes.length === 0 && pathGlobs.length === 0) return false;

    let rel = relative(root, entryPath).replace(/\\/g, "/");
    if (isCaseInsensitive) rel = rel.toLowerCase();

    for (const prefix of pathPrefixes) {
      if (rel === prefix || rel.startsWith(`${prefix}/`)) return true;
    }
    return pathGlobs.some((glob) => globMatch(glob, rel));
  };
}

/**
 * Returns true when a matched artifact should be skipped.
 *
 * Delegates to compileIgnoreMatcher() so the two implementations cannot drift;
 * note the compiled matcher normalizes trailing slashes, so `ignore: ["dist/"]`
 * also skips a top-level `dist` entry (the pre-compiled form did not).
 */
export function isIgnoredEntry(
  targetDir: string,
  entryPath: string,
  entryName: string,
  ignore: string[],
): boolean {
  const match = compileIgnoreMatcher(targetDir, ignore);
  return match ? match(entryPath, entryName) : false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load and merge config from all layers.
 *
 * Priority (highest → lowest for scalars): CLI > explicit config path > project
 * `.sweeprc` > global config > built-in defaults.
 *
 * `patterns` and `ignore` merge across all layers (deduped).
 * `disabledPatterns` merges global → project → CLI, then subtracts from patterns.
 */
export function loadConfig(
  cwd: string,
  explicitConfigPath?: string,
  cliOverrides: Partial<SweepConfig> = {},
  onWarning?: (message: string) => void,
): SweepConfig {
  const global = getGlobalConfig() ?? {};

  let project: Partial<SweepConfig> = {};
  if (explicitConfigPath) {
    // An explicit --config that does not resolve is a typo, not a request for
    // defaults - fail loudly (exit 3) instead of scanning with nothing.
    const resolvedPath = resolve(explicitConfigPath);
    if (!existsSync(resolvedPath)) {
      throw new ConfigParseError(`Config file not found: ${resolvedPath}`);
    }
    // An explicit file replaces the discovered-project layer entirely; fields
    // it omits still inherit from global config and built-in defaults.
    project = readJsonConfig(resolvedPath) ?? {};
  } else {
    project = findProjectConfig(cwd) ?? {};
  }

  const disabledPatterns = mergeStringArrays(
    checkedStringArray(global.disabledPatterns, "disabledPatterns", "global config"),
    checkedStringArray(project.disabledPatterns, "disabledPatterns", "project config"),
    checkedStringArray(cliOverrides.disabledPatterns, "disabledPatterns", "CLI flags"),
  );

  const patterns = subtractPatterns(
    mergeStringArrays(
      DEFAULT_CONFIG.patterns,
      checkedStringArray(global.patterns, "patterns", "global config"),
      checkedStringArray(project.patterns, "patterns", "project config"),
      checkedStringArray(cliOverrides.patterns, "patterns", "CLI flags"),
    ),
    disabledPatterns,
  );

  const ignore = mergeStringArrays(
    DEFAULT_CONFIG.ignore,
    checkedStringArray(global.ignore, "ignore", "global config"),
    checkedStringArray(project.ignore, "ignore", "project config"),
    checkedStringArray(cliOverrides.ignore, "ignore", "CLI flags"),
  );

  // A hostile or hand-mangled config could carry thousands of patterns; each
  // compiles to a regex tested against every walked entry.
  const MAX_MERGED_PATTERNS = 512;
  for (const [field, list] of [
    ["patterns", patterns],
    ["ignore", ignore],
    ["disabledPatterns", disabledPatterns],
  ] as const) {
    if (list.length > MAX_MERGED_PATTERNS) {
      throw new ConfigParseError(
        `"${field}" has ${list.length} entries (max ${MAX_MERGED_PATTERNS})`,
      );
    }
  }
  for (const p of patterns) assertSafePattern(p);
  for (const p of ignore) assertSafePattern(p);
  for (const p of disabledPatterns) assertSafePattern(p);

  // Presence, not nullish coalescing: null deliberately disables a byte cap.
  const maxSizeGB =
    cliOverrides.maxSizeGB !== undefined
      ? cliOverrides.maxSizeGB
      : project.maxSizeGB !== undefined
        ? project.maxSizeGB
        : global.maxSizeGB !== undefined
          ? global.maxSizeGB
          : DEFAULT_CONFIG.maxSizeGB;
  const depth = cliOverrides.depth ?? project.depth ?? global.depth ?? DEFAULT_CONFIG.depth;

  if (
    cliOverrides.maxSizeGB === undefined &&
    project.maxSizeGB === null &&
    typeof global.maxSizeGB === "number"
  ) {
    onWarning?.(
      `project config disables the global ${global.maxSizeGB} GiB deletion ceiling; review this policy before applying`,
    );
  }

  // Scalars come from hand-edited config files - validate rather than letting
  // NaN-adjacent or negative values silently warp scan/delete behavior.
  if (
    maxSizeGB !== null &&
    (!Number.isFinite(maxSizeGB) ||
      maxSizeGB < 0 ||
      maxSizeGB > Number.MAX_SAFE_INTEGER / 1024 ** 3)
  ) {
    throw new ConfigParseError(
      `"maxSizeGB" must be null or a non-negative safe byte ceiling in GiB (got ${maxSizeGB})`,
    );
  }
  if (!Number.isInteger(depth) || depth < -1) {
    throw new ConfigParseError(`"depth" must be -1 or a non-negative integer (got ${depth})`);
  }

  return {
    patterns,
    ignore,
    maxSizeGB,
    depth,
    ...(disabledPatterns.length > 0 ? { disabledPatterns } : {}),
  };
}

/**
 * Rebuild scan config after a UI rescan. UI pattern toggles are authoritative;
 * scalar fields and ignore rules are preserved from the active scan config.
 */
export function buildRescanConfig(
  current: SweepConfig,
  ui: { disabledPatterns: string[]; extraPatterns: string[] },
): SweepConfig {
  const disabledSet = new Set(ui.disabledPatterns);
  const enabledCatalog = DEFAULT_PATTERNS.filter((pattern) => !disabledSet.has(pattern));
  // Custom patterns can be toggled off in the editor too - a disabled extra
  // must not silently keep matching.
  const enabledExtras = ui.extraPatterns.filter((pattern) => !disabledSet.has(pattern));
  const patterns = [...new Set([...enabledCatalog, ...enabledExtras])];

  for (const pattern of patterns) assertSafePattern(pattern);
  for (const pattern of ui.disabledPatterns) assertSafePattern(pattern);

  return {
    patterns,
    ignore: current.ignore,
    maxSizeGB: current.maxSizeGB,
    depth: current.depth,
    ...(ui.disabledPatterns.length > 0 ? { disabledPatterns: ui.disabledPatterns } : {}),
  };
}
