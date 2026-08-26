import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve } from "node:path";
import type { SweepConfig } from "@kitsunekode/sweep-protocol";
import { assertSafePattern } from "./guardrails.js";

export class ConfigParseError extends Error {
  readonly code = 3;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigParseError";
  }
}

export const DEFAULT_PATTERNS: string[] = [
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".parcel-cache",
  ".nuxt",
  ".svelte-kit",
  "target",
  "coverage",
  ".nyc_output",
  ".vite",
  "*.tsbuildinfo",
];

export const DEFAULT_CONFIG: SweepConfig = {
  patterns: DEFAULT_PATTERNS,
  ignore: [],
  maxSizeGB: 10,
  depth: -1,
};

/** Starter `.sweeprc` scaffold written by `sweep init`. */
export const INIT_SWEEPRC_TEMPLATE = {
  patterns: [".custom-output"],
  ignore: ["packages/vendor-patched"],
  maxSizeGB: 10,
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

function readJsonConfig(filePath: string): Partial<SweepConfig> | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Partial<SweepConfig>;
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
  return readJsonConfig(configPath);
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
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
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
    if (expectedType === "number" && typeof value !== "number") {
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
  if (existsSync(configPath) && !force) {
    return "exists";
  }

  writeFileSync(configPath, `${JSON.stringify(INIT_SWEEPRC_TEMPLATE, null, 2)}\n`, "utf-8");
  return "created";
}

function getGlobalConfig(): Partial<SweepConfig> | null {
  const configDir =
    process.env.XDG_CONFIG_HOME ||
    (process.platform === "win32" && process.env.APPDATA
      ? process.env.APPDATA
      : join(homedir(), ".config"));
  const globalPath = join(configDir, "sweep", "config.json");
  return readJsonConfig(globalPath);
}

// ─── Merge helpers ────────────────────────────────────────────────────────────

/** Concatenate and deduplicate string arrays, skipping undefined layers */
function mergeStringArrays(...sources: Array<string[] | undefined>): string[] {
  const all = sources.flatMap((s) => s ?? []);
  return [...new Set(all)];
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
 * Returns null when there are no ignore rules — callers skip the check entirely.
 */
export function compileIgnoreMatcher(targetDir: string, ignore: string[]): IgnoreMatcher | null {
  if (ignore.length === 0) return null;

  const root = resolve(targetDir);
  const exactNames = new Set<string>();
  const pathPrefixes: string[] = [];

  for (const pattern of ignore) {
    if (pattern.includes("/")) {
      const normalized = pattern.replace(/\/+$/, "");
      if (normalized.length > 0) pathPrefixes.push(normalized);
    } else {
      exactNames.add(pattern);
    }
  }

  return (entryPath, entryName) => {
    if (exactNames.has(entryName)) return true;
    if (pathPrefixes.length === 0) return false;

    const rel = relative(root, entryPath).replace(/\\/g, "/");
    for (const prefix of pathPrefixes) {
      if (rel === prefix || rel.startsWith(`${prefix}/`)) return true;
    }
    return false;
  };
}

/**
 * Returns true when a matched artifact should be skipped.
 *
 * - Path-style ignore (`packages/vendor`): matches relative path prefix under targetDir.
 * - Name-style ignore (`dist`): matches the entry basename exactly.
 *
 * Prefer compileIgnoreMatcher() in scan loops — this form re-resolves paths per call.
 */
export function isIgnoredEntry(
  targetDir: string,
  entryPath: string,
  entryName: string,
  ignore: string[],
): boolean {
  if (ignore.length === 0) return false;

  const rel = relative(resolve(targetDir), resolve(entryPath)).replace(/\\/g, "/");

  for (const pattern of ignore) {
    if (pattern.includes("/")) {
      if (rel === pattern || rel.startsWith(`${pattern}/`)) {
        return true;
      }
      continue;
    }

    if (entryName === pattern) {
      return true;
    }
  }

  return false;
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
): SweepConfig {
  const global = getGlobalConfig() ?? {};

  let project: Partial<SweepConfig> = {};
  if (explicitConfigPath) {
    project = readJsonConfig(resolve(explicitConfigPath)) ?? {};
  } else {
    project = findProjectConfig(cwd) ?? {};
  }

  const disabledPatterns = mergeStringArrays(
    global.disabledPatterns,
    project.disabledPatterns,
    cliOverrides.disabledPatterns,
  );

  const patterns = subtractPatterns(
    mergeStringArrays(
      DEFAULT_CONFIG.patterns,
      global.patterns,
      project.patterns,
      cliOverrides.patterns,
    ),
    disabledPatterns,
  );

  const ignore = mergeStringArrays(
    DEFAULT_CONFIG.ignore,
    global.ignore,
    project.ignore,
    cliOverrides.ignore,
  );

  for (const p of patterns) assertSafePattern(p);
  for (const p of ignore) assertSafePattern(p);
  for (const p of disabledPatterns) assertSafePattern(p);

  return {
    patterns,
    ignore,
    maxSizeGB:
      cliOverrides.maxSizeGB ?? project.maxSizeGB ?? global.maxSizeGB ?? DEFAULT_CONFIG.maxSizeGB,
    depth: cliOverrides.depth ?? project.depth ?? global.depth ?? DEFAULT_CONFIG.depth,
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
  const patterns = [...new Set([...enabledCatalog, ...ui.extraPatterns])];

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
