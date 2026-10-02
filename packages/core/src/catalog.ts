/**
 * The curated pattern catalog - every name sweep knows about, grouped by
 * ecosystem, with an honest note on why the directory is safe to remove.
 *
 * `byDefault` is the trust boundary: a pattern only ships enabled when the
 * name is machine-created and ecosystem-canonical (nobody authors a
 * `node_modules/` or `.next/` directory by hand). Generic names like `build`,
 * `dist`, `out`, `coverage` stay opt-in - they can plausibly hold files a
 * user wrote themselves, and a cleanup tool must never presume otherwise.
 */

import { compileGlobMatchers } from "./glob-match.js";

export interface CatalogEntry {
  /** Directory/file name or glob (`*`, `?`). */
  pattern: string;
  /** Grouping label shown in the pattern menu. */
  ecosystem: string;
  /** Enabled without any user action. */
  byDefault: boolean;
  /** One-line justification shown next to the toggle. */
  note: string;
}

/** Display order for ecosystems in the pattern menu. */
export const CATALOG_ECOSYSTEMS = [
  "javascript",
  "typescript",
  "rust",
  "python",
  "jvm",
  "dotnet",
  "xcode",
  "c++",
  "dart",
  "generic",
] as const;

export type CatalogEcosystem = (typeof CATALOG_ECOSYSTEMS)[number];

export const PATTERN_CATALOG: readonly CatalogEntry[] = [
  // ── Enabled by default: machine-created names nobody authors by hand ──
  {
    pattern: "node_modules",
    ecosystem: "javascript",
    byDefault: true,
    note: "npm/bun/pnpm install output",
  },
  { pattern: ".next", ecosystem: "javascript", byDefault: true, note: "next.js build cache" },
  { pattern: ".nuxt", ecosystem: "javascript", byDefault: true, note: "nuxt build cache" },
  { pattern: ".svelte-kit", ecosystem: "javascript", byDefault: true, note: "sveltekit output" },
  { pattern: ".turbo", ecosystem: "javascript", byDefault: true, note: "turborepo cache" },
  { pattern: ".parcel-cache", ecosystem: "javascript", byDefault: true, note: "parcel cache" },
  { pattern: ".vite", ecosystem: "javascript", byDefault: true, note: "vite cache" },
  { pattern: ".nyc_output", ecosystem: "javascript", byDefault: true, note: "nyc coverage cache" },
  {
    pattern: "*.tsbuildinfo",
    ecosystem: "typescript",
    byDefault: true,
    note: "tsc incremental state",
  },
  { pattern: "target", ecosystem: "rust", byDefault: true, note: "cargo build output" },

  // ── Opt-in: regenerable, but the name could hold authored files ──
  {
    pattern: "dist",
    ecosystem: "javascript",
    byDefault: false,
    note: "bundler output - generic name",
  },
  {
    pattern: "coverage",
    ecosystem: "javascript",
    byDefault: false,
    note: "test coverage output - generic name",
  },
  {
    pattern: ".output",
    ecosystem: "javascript",
    byDefault: false,
    note: "nitro/nuxt3 server output",
  },
  {
    pattern: "bower_components",
    ecosystem: "javascript",
    byDefault: false,
    note: "legacy bower deps",
  },
  { pattern: "__pycache__", ecosystem: "python", byDefault: false, note: "cpython bytecode cache" },
  {
    pattern: ".venv",
    ecosystem: "python",
    byDefault: false,
    note: "virtualenv - slow to recreate",
  },
  { pattern: "venv", ecosystem: "python", byDefault: false, note: "virtualenv - slow to recreate" },
  { pattern: ".pytest_cache", ecosystem: "python", byDefault: false, note: "pytest cache" },
  { pattern: ".mypy_cache", ecosystem: "python", byDefault: false, note: "mypy type cache" },
  { pattern: ".ruff_cache", ecosystem: "python", byDefault: false, note: "ruff lint cache" },
  { pattern: "*.egg-info", ecosystem: "python", byDefault: false, note: "setuptools metadata" },
  { pattern: ".gradle", ecosystem: "jvm", byDefault: false, note: "gradle project cache" },
  { pattern: "obj", ecosystem: "dotnet", byDefault: false, note: "msbuild intermediates" },
  { pattern: "Pods", ecosystem: "xcode", byDefault: false, note: "cocoapods checkouts" },
  { pattern: "cmake-build-*", ecosystem: "c++", byDefault: false, note: "clion/cmake profiles" },
  { pattern: ".dart_tool", ecosystem: "dart", byDefault: false, note: "dart package cache" },
  // Truly generic names - opt-in only, the note says why.
  {
    pattern: "build",
    ecosystem: "generic",
    byDefault: false,
    note: "may be authored - verify before enabling",
  },
  {
    pattern: "out",
    ecosystem: "generic",
    byDefault: false,
    note: "may be authored - verify before enabling",
  },
];

/** Patterns a bare `sweep` run scans for - catalog entries flagged byDefault. */
export const DEFAULT_PATTERNS: string[] = PATTERN_CATALOG.filter((e) => e.byDefault).map(
  (e) => e.pattern,
);

export const DEFAULT_PATTERN_SET: ReadonlySet<string> = new Set(DEFAULT_PATTERNS);

/** Every pattern name the catalog knows - the UI lists these as first-class toggles. */
export const CATALOG_PATTERNS: string[] = PATTERN_CATALOG.map((e) => e.pattern);

const OPT_IN_PATTERNS: string[] = PATTERN_CATALOG.filter((e) => !e.byDefault).map((e) => e.pattern);

const entryByPattern = new Map(PATTERN_CATALOG.map((e) => [e.pattern, e]));

export function catalogEntryFor(pattern: string): CatalogEntry | undefined {
  return entryByPattern.get(pattern);
}

// ─── Name classification ──────────────────────────────────────────────────────
//
// The planner asks "what does the catalog say about this *name*" to assign a
// risk tier. The matched *name* - not which pattern fired - is what makes an
// artifact safe to presume: `node_modules` matched via a custom `*` glob is
// still dependency output, while `dist` stays ambiguous no matter how it was
// found. Matching uses the same glob semantics as the scanner (`*` any,
// `?` one Unicode scalar, case-folded where the filesystem is) - literally
// the same `globMatch` implementation, not a parallel regex compile.

export type CatalogMatch = "default" | "opt-in";

const NAME_MATCH_CASE_FOLD = process.platform === "darwin" || process.platform === "win32";

const defaultNameMatcher = compileGlobMatchers(DEFAULT_PATTERNS, NAME_MATCH_CASE_FOLD);
const optInNameMatcher = compileGlobMatchers(OPT_IN_PATTERNS, NAME_MATCH_CASE_FOLD);

/**
 * Classify a scanned entry name against the catalog: `"default"` for names a
 * shipping-default pattern covers, `"opt-in"` for curated names that only scan
 * when the user enables them, `null` for names the catalog does not know.
 */
export function catalogMatchFor(name: string): CatalogMatch | null {
  if (defaultNameMatcher(name)) return "default";
  if (optInNameMatcher(name)) return "opt-in";
  return null;
}
