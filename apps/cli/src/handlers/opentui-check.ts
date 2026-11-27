import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OPEN_TUI = "@opentui/core";

// Injected at build time by scripts/bundle.ts from the catalog range and the
// exact named imports extracted from dist/sweep-ui.js.
declare const __OPENTUI_REQUIRED_RANGE__: string | undefined;
declare const __OPENTUI_REQUIRED_EXPORTS__: string[] | undefined;

export const OPENTUI_REQUIRED_RANGE =
  typeof __OPENTUI_REQUIRED_RANGE__ === "string" ? __OPENTUI_REQUIRED_RANGE__ : "^0.6.8";

export const OPENTUI_REQUIRED_EXPORTS: readonly string[] = Array.isArray(
  typeof __OPENTUI_REQUIRED_EXPORTS__ !== "undefined" ? __OPENTUI_REQUIRED_EXPORTS__ : undefined,
)
  ? (__OPENTUI_REQUIRED_EXPORTS__ as string[])
  : [];

interface BunModuleResolver {
  resolveSync?: (specifier: string, from: string) => string;
}

function bunModuleResolver(): BunModuleResolver | undefined {
  return (globalThis as { Bun?: BunModuleResolver }).Bun;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(raw: string): ParsedSemver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    raw.trim(),
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNum = /^\d+$/.test(left);
    const rightNum = /^\d+$/.test(right);
    if (leftNum && rightNum) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff;
    } else if (leftNum !== rightNum) {
      return leftNum ? -1 : 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

interface PrimitiveComparator {
  op: ">=" | "<=" | ">" | "<" | "=";
  version: ParsedSemver;
  /** True only when the user/range explicitly wrote a prerelease comparator (not a synthetic `-0` upper bound). */
  explicitPrerelease: boolean;
}

function expandComparator(raw: string): PrimitiveComparator[] | null {
  const token = raw.trim();
  if (!token || token === "*" || token === "x" || token === "X") {
    return [];
  }

  if (token.startsWith("^")) {
    const base = parseSemver(token.slice(1));
    if (!base) return null;
    const upper: ParsedSemver =
      base.major > 0
        ? { major: base.major + 1, minor: 0, patch: 0, prerelease: ["0"] }
        : base.minor > 0
          ? { major: 0, minor: base.minor + 1, patch: 0, prerelease: ["0"] }
          : { major: 0, minor: 0, patch: base.patch + 1, prerelease: ["0"] };
    return [
      { op: ">=", version: base, explicitPrerelease: base.prerelease.length > 0 },
      { op: "<", version: upper, explicitPrerelease: false },
    ];
  }

  if (token.startsWith("~")) {
    const base = parseSemver(token.slice(1));
    if (!base) return null;
    const upper: ParsedSemver = {
      major: base.major,
      minor: base.minor + 1,
      patch: 0,
      prerelease: ["0"],
    };
    return [
      { op: ">=", version: base, explicitPrerelease: base.prerelease.length > 0 },
      { op: "<", version: upper, explicitPrerelease: false },
    ];
  }

  const opMatch = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!opMatch) return null;
  const op = (opMatch[1] ?? "=") as PrimitiveComparator["op"];
  const base = parseSemver(opMatch[2]!);
  if (!base) return null;
  return [{ op, version: base, explicitPrerelease: base.prerelease.length > 0 }];
}

function matchesPrimitive(version: ParsedSemver, comp: PrimitiveComparator): boolean {
  const cmp = compareSemver(version, comp.version);
  switch (comp.op) {
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    default:
      return cmp === 0;
  }
}

function sameReleaseTuple(a: ParsedSemver, b: ParsedSemver): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

/**
 * Pure-JS semver range check matching npm `semver@7` (default `includePrerelease: false`),
 * so `sweep doctor` and `sweep ui` agree with Bun/npm on both Node and Bun:
 * a prerelease version satisfies a comparator set only if every comparator passes
 * AND at least one explicit comparator in that set has a prerelease on the same
 * `[major, minor, patch]` tuple.
 */
export function satisfiesSemverRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  return range.split("||").some((branch) => {
    const tokens = branch.trim().split(/\s+/).filter(Boolean);
    const comparators: PrimitiveComparator[] = [];
    for (const token of tokens) {
      const expanded = expandComparator(token);
      if (expanded === null) return false;
      comparators.push(...expanded);
    }
    if (!comparators.every((comp) => matchesPrimitive(parsed, comp))) {
      return false;
    }
    if (parsed.prerelease.length > 0) {
      return comparators.some(
        (comp) => comp.explicitPrerelease && sameReleaseTuple(parsed, comp.version),
      );
    }
    return true;
  });
}

/** Walk up from a resolved entry file to locate the owning `@opentui/core/package.json`. */
export function readResolvedPackageVersion(
  entryPath: string,
  expectedName: string = OPEN_TUI,
): string | null {
  let dir = dirname(resolve(entryPath));
  for (let depth = 0; depth < 8; depth++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === expectedName && typeof parsed.version === "string") {
          return parsed.version;
        }
      } catch {
        // Ignore unreadable intermediate JSON files.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Statically collect ESM export names from a resolved JS entry without executing
 * Bun-only native FFI. Follows local `export * from` re-exports within the package.
 */
export function collectStaticModuleExports(entryPath: string): Set<string> | null {
  const resolvedEntry = resolve(entryPath);
  if (!existsSync(resolvedEntry)) return null;
  const exports = new Set<string>();
  const visited = new Set<string>();

  const visit = (filePath: string) => {
    const abs = resolve(filePath);
    if (visited.has(abs) || visited.size >= 64 || !existsSync(abs)) return;
    visited.add(abs);
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      return;
    }

    // Direct declaration exports: export const/let/var/function/class/async function Name
    for (const match of source.matchAll(
      /\bexport\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    )) {
      if (match[1]) exports.add(match[1]);
    }

    // Export lists: `export { a, b as c }` and `export { a, b as c } from "..."`
    for (const match of source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
      const list = match[1] ?? "";
      for (const item of list.split(",")) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+as\s+/);
        const exported = (parts[1] ?? parts[0] ?? "").trim();
        const unquoted =
          (exported.startsWith('"') && exported.endsWith('"')) ||
          (exported.startsWith("'") && exported.endsWith("'"))
            ? exported.slice(1, -1)
            : exported;
        if (unquoted) exports.add(unquoted);
      }
    }

    // Namespace re-exports: `export * as ns from "..."`
    for (const match of source.matchAll(/\bexport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/g)) {
      if (match[1]) exports.add(match[1]);
    }

    // Local wildcard re-exports: `export * from "./foo.js"`
    for (const match of source.matchAll(/\bexport\s+\*\s+from\s+["']([^"']+)["']/g)) {
      const target = match[1];
      if (!target || !target.startsWith(".")) continue;
      const base = resolve(dirname(abs), target);
      if (existsSync(base)) {
        visit(base);
      } else if (existsSync(`${base}.js`)) {
        visit(`${base}.js`);
      } else if (existsSync(join(base, "index.js"))) {
        visit(join(base, "index.js"));
      }
    }
  };

  visit(resolvedEntry);
  return exports;
}

/**
 * Resolve `@opentui/core` the same way `dist/sweep-ui.js` will: from the
 * installed `dist/` directory using Bun's ESM resolver first when on Bun, then
 * falling back to Node's `createRequire` anchored at the sibling UI path.
 */
export function defaultOpenTuiResolvers(): readonly (() => string)[] {
  const fromDir = dirname(fileURLToPath(import.meta.url));
  const siblingUiUrl = new URL("./sweep-ui.js", import.meta.url);
  return [
    () => {
      const resolveSync = bunModuleResolver()?.resolveSync;
      if (!resolveSync) throw new Error("bun resolver unavailable");
      return resolveSync(OPEN_TUI, fromDir);
    },
    () => createRequire(siblingUiUrl).resolve(OPEN_TUI),
    () => createRequire(import.meta.url).resolve(OPEN_TUI),
  ];
}

export function openTuiInstallHint(): string {
  return bunModuleResolver()
    ? "bun add -g @kitsunekode/sweep"
    : "npm install -g @kitsunekode/sweep";
}

export function openTuiMissingMessage(): string {
  return [
    "sweep ui needs @opentui/core, and this install does not have it.",
    `Reinstall sweep under Bun so the optional UI library installs:  ${openTuiInstallHint()}`,
    "Or run it without a global install:  bunx @kitsunekode/sweep ui <folder>",
    "Or use a standalone binary (UI embedded, no Node or Bun needed):",
    "  • macOS / Linux:  brew install kitsunekode/tap/sweep  (or install.sh)",
    "  • Windows / all platforms:  https://github.com/KitsuneKode/sweep/releases  (sweep-win-x64.exe on Windows)",
    "Then run:  sweep ui <folder>",
  ].join("\n");
}

function openTuiMismatchMessage(details: {
  resolvedPath: string;
  version: string | null;
  requiredRange: string;
  missingExports?: readonly string[];
  loadError?: string;
}): string {
  const versionLabel = details.version ?? "unknown version";
  const lines = [
    `sweep ui resolved an incompatible @opentui/core (${versionLabel}; requires ${details.requiredRange}) at:`,
    `  ${details.resolvedPath}`,
  ];
  if (details.missingExports && details.missingExports.length > 0) {
    const preview = details.missingExports.slice(0, 6).join(", ");
    const extra =
      details.missingExports.length > 6 ? ` (+${details.missingExports.length - 6} more)` : "";
    lines.push(`Missing required exports: ${preview}${extra}`);
  }
  if (details.loadError) {
    lines.push(`Load error: ${details.loadError}`);
  }
  lines.push(
    "This usually happens when a shared global node_modules has a different @opentui/core from another tool.",
    "Fixes:",
    `  • Reinstall sweep:  ${openTuiInstallHint()}`,
    "  • Run with bunx:  bunx @kitsunekode/sweep ui <folder>",
    "  • Use a standalone binary (UI embedded):  brew install kitsunekode/tap/sweep (macOS/Linux) or https://github.com/KitsuneKode/sweep/releases (Windows sweep-win-x64.exe, macOS, Linux)",
  );
  return lines.join("\n");
}

export type OpenTuiInspection =
  | {
      ok: true;
      resolvedPath: string;
      version: string | null;
      detail: string;
    }
  | {
      ok: false;
      reason: "missing" | "version_mismatch" | "missing_exports" | "load_error";
      resolvedPath?: string;
      version?: string | null;
      requiredRange: string;
      missingExports?: string[];
      detail: string;
      message: string;
    };

export interface OpenTuiInspectOptions {
  resolvers?: readonly (() => string)[];
  requiredRange?: string;
  requiredExports?: readonly string[];
  readVersion?: (entryPath: string) => string | null;
  readStaticExports?: (entryPath: string) => ReadonlySet<string> | null;
  loadModule?: (entryPath: string) => Promise<Record<string, unknown>>;
}

function resolveFirst(resolvers: readonly (() => string)[]): string | null {
  for (const resolveModule of resolvers) {
    try {
      return resolveModule();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Synchronous inspection of `@opentui/core` resolution, package.json version,
 * and static exports. Safe to run on both Node and Bun without loading native FFI.
 */
export function inspectOpenTui(options: OpenTuiInspectOptions = {}): OpenTuiInspection {
  const resolvers = options.resolvers ?? defaultOpenTuiResolvers();
  const requiredRange = options.requiredRange ?? OPENTUI_REQUIRED_RANGE;
  const requiredExports = options.requiredExports ?? OPENTUI_REQUIRED_EXPORTS;
  const readVersion = options.readVersion ?? readResolvedPackageVersion;
  const readStaticExports = options.readStaticExports ?? collectStaticModuleExports;

  const resolvedPath = resolveFirst(resolvers);
  if (!resolvedPath) {
    return {
      ok: false,
      reason: "missing",
      requiredRange,
      detail: `missing (requires ${requiredRange}); reinstall with \`bun add -g @kitsunekode/sweep\`, use \`bunx @kitsunekode/sweep ui\`, or install the standalone binary`,
      message: openTuiMissingMessage(),
    };
  }

  const version = readVersion(resolvedPath);
  const versionOk = version !== null && satisfiesSemverRange(version, requiredRange);

  const staticExports = requiredExports.length > 0 ? readStaticExports(resolvedPath) : null;
  const missingExports =
    staticExports !== null ? requiredExports.filter((name) => !staticExports.has(name)) : [];

  if (!versionOk) {
    const versionText = version ?? "unknown";
    const missingNote =
      missingExports.length > 0
        ? `; missing exports: ${missingExports.slice(0, 4).join(", ")}${missingExports.length > 4 ? ` (+${missingExports.length - 4})` : ""}`
        : "";
    return {
      ok: false,
      reason: "version_mismatch",
      resolvedPath,
      version,
      requiredRange,
      ...(missingExports.length > 0 ? { missingExports } : {}),
      detail: `incompatible version ${versionText} (requires ${requiredRange}) at ${resolvedPath}${missingNote}`,
      message: openTuiMismatchMessage({
        resolvedPath,
        version,
        requiredRange,
        missingExports,
      }),
    };
  }

  if (missingExports.length > 0) {
    return {
      ok: false,
      reason: "missing_exports",
      resolvedPath,
      version,
      requiredRange,
      missingExports,
      detail: `missing exports (${missingExports.slice(0, 4).join(", ")}${missingExports.length > 4 ? ` (+${missingExports.length - 4})` : ""}) in ${version} at ${resolvedPath}`,
      message: openTuiMismatchMessage({
        resolvedPath,
        version,
        requiredRange,
        missingExports,
      }),
    };
  }

  return {
    ok: true,
    resolvedPath,
    version,
    detail: version ? `${version} (${resolvedPath})` : resolvedPath,
  };
}

/**
 * Full async verification: runs `inspectOpenTui`, and on Bun (or when a custom
 * `loadModule` is supplied) also verifies live runtime exports against the
 * resolved module namespace so broken re-exports or FFI load failures surface
 * with the same actionable diagnostic before importing `dist/sweep-ui.js`.
 */
export async function verifyOpenTuiAvailable(
  options: OpenTuiInspectOptions = {},
): Promise<OpenTuiInspection> {
  const staticResult = inspectOpenTui(options);
  if (!staticResult.ok) return staticResult;

  const requiredRange = options.requiredRange ?? OPENTUI_REQUIRED_RANGE;
  const requiredExports = options.requiredExports ?? OPENTUI_REQUIRED_EXPORTS;
  const shouldLoadRuntime =
    options.loadModule !== undefined ||
    (typeof process.versions.bun === "string" &&
      requiredExports.length > 0 &&
      existsSync(staticResult.resolvedPath));

  if (!shouldLoadRuntime) return staticResult;

  const loadModule =
    options.loadModule ??
    (async (entryPath: string) =>
      (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>);

  try {
    const mod = await loadModule(staticResult.resolvedPath);
    const missingExports = requiredExports.filter((name) => !(name in mod));
    if (missingExports.length > 0) {
      return {
        ok: false,
        reason: "missing_exports",
        resolvedPath: staticResult.resolvedPath,
        version: staticResult.version,
        requiredRange,
        missingExports,
        detail: `missing exports (${missingExports.slice(0, 4).join(", ")}${missingExports.length > 4 ? ` (+${missingExports.length - 4})` : ""}) in ${staticResult.version ?? "unknown"} at ${staticResult.resolvedPath}`,
        message: openTuiMismatchMessage({
          resolvedPath: staticResult.resolvedPath,
          version: staticResult.version,
          requiredRange,
          missingExports,
        }),
      };
    }
    return staticResult;
  } catch (error) {
    const loadError = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: "load_error",
      resolvedPath: staticResult.resolvedPath,
      version: staticResult.version,
      requiredRange,
      detail: `failed to load ${staticResult.version ?? "unknown"} at ${staticResult.resolvedPath}: ${loadError}`,
      message: openTuiMismatchMessage({
        resolvedPath: staticResult.resolvedPath,
        version: staticResult.version,
        requiredRange,
        loadError,
      }),
    };
  }
}
