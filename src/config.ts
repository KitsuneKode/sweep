import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import type { SweepConfig } from "./types.js";

export const DEFAULT_PATTERNS: string[] = [
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".parcel-cache",
  "target",
  "out",
  ".nuxt",
  ".svelte-kit",
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

// ─── Config file reading ──────────────────────────────────────────────────────

function readJsonConfig(filePath: string): Partial<SweepConfig> | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Partial<SweepConfig>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config at ${filePath}: ${msg}`, { cause: err });
  }
}

/**
 * Walk up from startDir, looking for .sweeprc (JSON format, no extension).
 * Returns the first one found (closest to CWD wins), or null.
 */
function findProjectConfig(startDir: string): Partial<SweepConfig> | null {
  let dir = resolve(startDir);
  const fsRoot = parse(dir).root;

  while (dir !== fsRoot) {
    const candidate = join(dir, ".sweeprc");
    if (existsSync(candidate)) {
      return readJsonConfig(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) break; // safety: already at root
    dir = parent;
  }
  return null;
}

function getGlobalConfig(): Partial<SweepConfig> | null {
  const globalPath = join(homedir(), ".config", "sweep", "config.json");
  return readJsonConfig(globalPath);
}

// ─── Merge helpers ────────────────────────────────────────────────────────────

/** Concatenate and deduplicate string arrays, skipping undefined layers */
function mergeStringArrays(...sources: Array<string[] | undefined>): string[] {
  const all = sources.flatMap((s) => s ?? []);
  return [...new Set(all)];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load and merge config from all layers.
 *
 * Priority (highest → lowest): cliOverrides > project .sweeprc.json > global config > defaults
 *
 * Arrays (patterns, ignore) are MERGED + deduplicated, not replaced.
 * Scalars (maxSizeGB, depth) use the highest-priority source that defines them.
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

  return {
    patterns: mergeStringArrays(
      DEFAULT_CONFIG.patterns,
      global.patterns,
      project.patterns,
      cliOverrides.patterns,
    ),
    ignore: mergeStringArrays(
      DEFAULT_CONFIG.ignore,
      global.ignore,
      project.ignore,
      cliOverrides.ignore,
    ),
    maxSizeGB:
      cliOverrides.maxSizeGB ?? project.maxSizeGB ?? global.maxSizeGB ?? DEFAULT_CONFIG.maxSizeGB,
    depth: cliOverrides.depth ?? project.depth ?? global.depth ?? DEFAULT_CONFIG.depth,
  };
}
