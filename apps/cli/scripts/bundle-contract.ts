/**
 * Build-time and preflight contract helpers for verifying `dist/` bundles and
 * the actual packed npm tarball against the packed manifest, runtime import
 * targets, computed imports, and installed dependency versions/exports.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

// Bun exposes some npm-package polyfills (e.g. "ws", "undici") in `builtinModules`
// that are NOT standard Node.js builtins; treat them as bare npm packages so an
// accidental import (like React devtools importing "ws") cannot slip past preflight.
const NON_NODE_BUN_POLYFILLS = new Set(["ws", "undici"]);

const NODE_BUILTINS = new Set<string>(
  builtinModules
    .filter((mod) => !NON_NODE_BUN_POLYFILLS.has(mod.replace(/^node:/, "")))
    .flatMap((mod) =>
      mod.startsWith("node:") ? [mod, mod.slice("node:".length)] : [mod, `node:${mod}`],
    ),
);

const REACT_DEV_MARKERS = ["jsxDEV", "runWithFiberInDEV"] as const;
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export type TargetRuntime = "node" | "bun";

export function stripShebang(source: string): string {
  return source.startsWith("#!") ? source.replace(/^#![^\r\n]*\r?\n?/, "") : source;
}

/**
 * Extract the npm package name from a bare specifier (`@scope/pkg/sub` -> `@scope/pkg`).
 * Returns `null` for relative paths, builtins, `#` subpath imports, and URL schemes
 * (`node:`, `bun:`, `data:`, `file:`, `http:`, `https:`, etc.).
 */
export function barePackageName(specifier: string): string | null {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("\\") ||
    specifier.startsWith("#") ||
    specifier === "bun" ||
    URL_SCHEME_RE.test(specifier) ||
    NODE_BUILTINS.has(specifier)
  ) {
    return null;
  }
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  }
  return specifier.split("/")[0] || null;
}

export interface ComputedImportCall {
  kind: "import" | "require";
  expression: string;
}

export interface BundleRuntimeReferences {
  /** Complete bare external specifiers (e.g. `@opentui/core`, `@scope/pkg/sub`). */
  externalSpecifiers: string[];
  /** Unique owning npm package names derived from `externalSpecifiers`. */
  barePackages: string[];
  /** Relative static/dynamic import specifiers (`./...`, `../...`). */
  relativeImports: string[];
  /** Relative sibling paths referenced via `new URL("./...", import.meta.url)`. */
  urlSiblings: string[];
  /** Package `#...` subpath imports. */
  subpathImports: string[];
  /** URL-scheme imports like `data:` or `file:` (excluding `node:`/`bun:`). */
  urlImports: string[];
  /** Live `import(<expr>)` / `require(<expr>)` calls whose argument is not a plain string literal. */
  computedImports: ComputedImportCall[];
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[\w$]/.test(ch);
}

function skipWhitespaceAndComments(code: string, pos: number): number {
  let i = pos;
  while (i < code.length) {
    const ch = code[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
    } else if (ch === "/" && code[i + 1] === "/") {
      i += 2;
      while (i < code.length && code[i] !== "\n") i++;
    } else if (ch === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
    } else {
      break;
    }
  }
  return i;
}

function readBalancedParens(
  code: string,
  openParenIndex: number,
): { inner: string; end: number } | null {
  if (code[openParenIndex] !== "(") return null;
  let depth = 1;
  let i = openParenIndex + 1;
  while (i < code.length && depth > 0) {
    const ch = code[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipStringOrTemplate(code, i);
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      i += 2;
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    i++;
  }
  if (depth !== 0) return null;
  return { inner: code.slice(openParenIndex + 1, i - 1), end: i };
}

function skipStringOrTemplate(code: string, start: number): number {
  const quote = code[start]!;
  let i = start + 1;
  if (quote !== "`") {
    while (i < code.length) {
      const ch = code[i]!;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) return i + 1;
      i++;
    }
    return i;
  }
  while (i < code.length) {
    const ch = code[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return i + 1;
    if (ch === "$" && code[i + 1] === "{") {
      i += 2;
      let braceDepth = 1;
      while (i < code.length && braceDepth > 0) {
        const inner = code[i]!;
        if (inner === "'" || inner === '"' || inner === "`") {
          i = skipStringOrTemplate(code, i);
          continue;
        }
        if (inner === "{") braceDepth++;
        else if (inner === "}") braceDepth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

function parsePlainStringLiteral(expr: string): string | null {
  const trimmed = expr.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0]!;
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  if (quote === "`" && trimmed.includes("${")) return null;
  if (skipStringOrTemplate(trimmed, 0) !== trimmed.length) return null;
  const inner = trimmed.slice(1, -1);
  // Reject unescaped line breaks or complex escapes only if invalid; handle basic escapes.
  return inner.replace(/\\(['"`\\])/g, "$1");
}

function prevSignificantChar(code: string, index: number): string {
  let i = index - 1;
  while (i >= 0) {
    const ch = code[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i--;
      continue;
    }
    return ch;
  }
  return "";
}

/**
 * Scan executable JS code (skipping comments, string literals, and template text)
 * for `new URL("./...", import.meta.url)`, computed `import(expr)`, and computed `require(expr)`.
 */
export function scanRuntimeLoadExpressions(source: string): {
  urlSiblings: string[];
  computedImports: ComputedImportCall[];
} {
  const code = stripShebang(source);
  const urlSiblings = new Set<string>();
  const computedImports: ComputedImportCall[] = [];

  const scanRange = (start: number, end: number) => {
    let i = start;
    while (i < end) {
      const ch = code[i]!;
      if (ch === "'" || ch === '"') {
        i = skipStringOrTemplate(code, i);
        continue;
      }
      if (ch === "`") {
        // Skip template text, but scan `${...}` expressions inside it.
        i++;
        while (i < end) {
          const tc = code[i]!;
          if (tc === "\\") {
            i += 2;
            continue;
          }
          if (tc === "`") {
            i++;
            break;
          }
          if (tc === "$" && code[i + 1] === "{") {
            const exprStart = i + 2;
            let braceDepth = 1;
            let j = exprStart;
            while (j < end && braceDepth > 0) {
              const ic = code[j]!;
              if (ic === "'" || ic === '"' || ic === "`") {
                j = skipStringOrTemplate(code, j);
                continue;
              }
              if (ic === "{") braceDepth++;
              else if (ic === "}") braceDepth--;
              j++;
            }
            scanRange(exprStart, j - 1);
            i = j;
            continue;
          }
          i++;
        }
        continue;
      }
      if (ch === "/" && code[i + 1] === "/") {
        i += 2;
        while (i < end && code[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && code[i + 1] === "*") {
        i += 2;
        while (i < end && !(code[i] === "*" && code[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (isIdentStart(ch)) {
        const wordStart = i;
        while (i < end && isIdentPart(code[i]!)) i++;
        const word = code.slice(wordStart, i);
        const prev = prevSignificantChar(code, wordStart);
        if (prev === ".") continue;

        if (word === "import" || word === "require") {
          const next = skipWhitespaceAndComments(code, i);
          if (code[next] === "(") {
            const call = readBalancedParens(code, next);
            if (call) {
              const firstArg = splitTopLevelArgs(call.inner)[0] ?? "";
              if (parsePlainStringLiteral(firstArg) === null) {
                computedImports.push({
                  kind: word,
                  expression: firstArg.trim(),
                });
              }
              // Continue scanning inside the arguments for nested calls (e.g. `import(new URL(...).href)`).
              scanRange(next + 1, call.end - 1);
              i = call.end;
              continue;
            }
          }
        } else if (word === "new") {
          const afterNew = skipWhitespaceAndComments(code, i);
          if (
            code.slice(afterNew, afterNew + 3) === "URL" &&
            !isIdentPart(code[afterNew + 3] ?? "")
          ) {
            const parenPos = skipWhitespaceAndComments(code, afterNew + 3);
            if (code[parenPos] === "(") {
              const call = readBalancedParens(code, parenPos);
              if (call) {
                const args = splitTopLevelArgs(call.inner);
                if (args.length >= 2 && args[1]!.replace(/\s+/g, "") === "import.meta.url") {
                  const target = parsePlainStringLiteral(args[0]!);
                  if (target && (target.startsWith("./") || target.startsWith("../"))) {
                    urlSiblings.add(target);
                  }
                }
                i = call.end;
                continue;
              }
            }
          }
        }
        continue;
      }
      i++;
    }
  };

  scanRange(0, code.length);
  return {
    urlSiblings: [...urlSiblings].sort(),
    computedImports,
  };
}

function splitTopLevelArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipStringOrTemplate(inner, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  if (start <= inner.length) args.push(inner.slice(start));
  return args;
}

/** Collect every static and dynamic runtime import target from a JS bundle. */
export function scanBundleRuntimeReferences(source: string): BundleRuntimeReferences {
  const transpiler = new Bun.Transpiler({ loader: "js" });
  const clean = stripShebang(source);
  const imports = transpiler.scanImports(clean);

  const externalSpecifiers = new Set<string>();
  const barePackages = new Set<string>();
  const relativeImports = new Set<string>();
  const subpathImports = new Set<string>();
  const urlImports = new Set<string>();

  for (const entry of imports) {
    const spec = entry.path;
    if (!spec) continue;
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
      relativeImports.add(spec);
      continue;
    }
    if (spec.startsWith("#")) {
      subpathImports.add(spec);
      continue;
    }
    if (
      spec.startsWith("node:") ||
      spec.startsWith("bun:") ||
      spec === "bun" ||
      NODE_BUILTINS.has(spec)
    ) {
      continue;
    }
    if (URL_SCHEME_RE.test(spec)) {
      urlImports.add(spec);
      continue;
    }
    const pkg = barePackageName(spec);
    if (pkg) {
      externalSpecifiers.add(spec);
      barePackages.add(pkg);
    }
  }

  const { urlSiblings, computedImports } = scanRuntimeLoadExpressions(clean);
  return {
    externalSpecifiers: [...externalSpecifiers].sort(),
    barePackages: [...barePackages].sort(),
    relativeImports: [...relativeImports].sort(),
    urlSiblings,
    subpathImports: [...subpathImports].sort(),
    urlImports: [...urlImports].sort(),
    computedImports,
  };
}

/** Return sorted unique bare npm package names imported by a JS bundle. */
export function extractBarePackageImports(source: string): string[] {
  return scanBundleRuntimeReferences(source).barePackages;
}

/**
 * Extract every named import identifier (exported name, before any `as` alias)
 * taken from `packageName` in an ESM bundle.
 */
export function extractNamedImportsFromPackage(source: string, packageName: string): string[] {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\b(?:import|export)\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*["']${escaped}["']`,
    "g",
  );
  const names = new Set<string>();
  const clean = stripShebang(source);
  for (const match of clean.matchAll(pattern)) {
    const clause = match[1] ?? "";
    for (const part of clause.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // Handle `exportedName as localAlias` and `"string-export" as localAlias`.
      const exported = trimmed.split(/\s+as\s+/)[0]?.trim();
      if (!exported) continue;
      const unquoted =
        (exported.startsWith('"') && exported.endsWith('"')) ||
        (exported.startsWith("'") && exported.endsWith("'"))
          ? exported.slice(1, -1)
          : exported;
      if (unquoted) names.add(unquoted);
    }
  }
  return [...names].sort();
}

/** Detect React development markers that must never ship in production dist bundles. */
export function findReactDevMarkers(source: string): string[] {
  return REACT_DEV_MARKERS.filter((marker) => source.includes(marker));
}

/** Walk up from a resolved entry file to find the owning package.json. */
export function findOwningPackageInfo(
  entryPath: string,
  expectedName: string,
): { packageDir: string; version: string } | null {
  let dir = dirname(resolve(entryPath));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === expectedName && typeof parsed.version === "string") {
          return { packageDir: dir, version: parsed.version };
        }
      } catch {
        // Keep walking upward if an intermediate directory has a non-package JSON.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Collect all ESM export names from a resolved JS entry, following local `export * from`. */
export function collectBunModuleExports(entryPath: string): Set<string> {
  const transpiler = new Bun.Transpiler({ loader: "js" });
  const exports = new Set<string>();
  const visited = new Set<string>();

  const visit = (filePath: string) => {
    const resolved = resolve(filePath);
    if (visited.has(resolved) || visited.size >= 64 || !existsSync(resolved)) return;
    visited.add(resolved);
    const source = stripShebang(readFileSync(resolved, "utf8"));
    const scanned = transpiler.scan(source);
    for (const name of scanned.exports) exports.add(name);
    for (const match of source.matchAll(/\bexport\s+\*\s+from\s+["']([^"']+)["']/g)) {
      const target = match[1];
      if (!target || !target.startsWith(".")) continue;
      const next = resolve(dirname(resolved), target);
      if (existsSync(next)) {
        visit(next);
      } else if (existsSync(`${next}.js`)) {
        visit(`${next}.js`);
      }
    }
  };

  visit(entryPath);
  return exports;
}

/**
 * Resolve a complete external ESM specifier using the target runtime's conditions:
 * - `"bun"`: `Bun.resolveSync` (Bun export conditions)
 * - `"node"`: Node's native `import.meta.resolve` anchored at `fromDir` (Node ESM conditions)
 */
export function resolveExternalSpecifier(
  specifier: string,
  fromDir: string,
  runtime: TargetRuntime,
  nodeBin: string = "node",
): string | null {
  if (runtime === "bun") {
    try {
      return Bun.resolveSync(specifier, fromDir);
    } catch {
      return null;
    }
  }
  try {
    const parentUrl = pathToFileURL(join(resolve(fromDir), "__preflight_resolve__.mjs")).href;
    const out = execFileSync(
      nodeBin,
      [
        "--input-type=module",
        "-e",
        `import { fileURLToPath } from "node:url"; console.log(fileURLToPath(import.meta.resolve(${JSON.stringify(specifier)}, ${JSON.stringify(parentUrl)})));`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface InstalledPackageResolution {
  entryPath: string;
  version: string;
  exports?: ReadonlySet<string>;
}

export interface ComputedImportRule {
  file: string;
  kind: "import" | "require";
  matches: (expression: string, context: { source: string; urlSiblings: string[] }) => boolean;
}

/**
 * Explicit coverage rules for the three audited dynamic imports in `sweep.js` and
 * `sweep-lib.js`. Any other computed `import(...)` or `require(...)` fails preflight.
 */
export const DEFAULT_COMPUTED_IMPORT_RULES: readonly ComputedImportRule[] = [
  // apps/cli/src/handlers/ui.ts: loads the sibling `./sweep-ui.js` (also verified by urlSiblings)
  {
    file: "sweep.js",
    kind: "import",
    matches: (expr, ctx) => expr === "sibling" && ctx.urlSiblings.includes("./sweep-ui.js"),
  },
  {
    file: "sweep-lib.js",
    kind: "import",
    matches: (expr, ctx) => expr === "sibling" && ctx.urlSiblings.includes("./sweep-ui.js"),
  },
  // apps/cli/src/handlers/ui.ts: dev-only fallback when `./sweep-ui.js` is absent
  {
    file: "sweep.js",
    kind: "import",
    matches: (expr, ctx) =>
      expr === "workspacePackage" &&
      /(?:const|let|var)\s+workspacePackage\s*=\s*["']@kitsunekode\/sweep-ui["']/.test(ctx.source),
  },
  {
    file: "sweep-lib.js",
    kind: "import",
    matches: (expr, ctx) =>
      expr === "workspacePackage" &&
      /(?:const|let|var)\s+workspacePackage\s*=\s*["']@kitsunekode\/sweep-ui["']/.test(ctx.source),
  },
  // apps/cli/src/handlers/opentui-check.ts: imports the already-resolved @opentui/core file URL
  {
    file: "sweep.js",
    kind: "import",
    matches: (expr) => /^pathToFileURL\([A-Za-z_$][\w$]*\)\.href$/.test(expr),
  },
  {
    file: "sweep-lib.js",
    kind: "import",
    matches: (expr) => /^pathToFileURL\([A-Za-z_$][\w$]*\)\.href$/.test(expr),
  },
];

function collectStringTargets(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringTargets(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectStringTargets(nested, out);
    }
  }
}

/** Collect all relative file targets advertised by `exports` and `bin` in a manifest. */
export function collectManifestEntryTargets(manifest: Record<string, unknown>): string[] {
  const raw: string[] = [];
  if (manifest.exports !== undefined) collectStringTargets(manifest.exports, raw);
  if (manifest.bin !== undefined) collectStringTargets(manifest.bin, raw);
  return [...new Set(raw.map((target) => target.replace(/^\.\//, "").replace(/\\/g, "/")))].sort();
}

/**
 * Pure-JS reader for gzipped npm tarballs (`.tgz`) so preflight can inspect the
 * exact packed file list and `package/package.json` across Linux, macOS, and Windows.
 */
export function readPackedTarball(tgzPath: string): {
  entries: Set<string>;
  manifest: Record<string, unknown> | null;
} {
  const tar = gunzipSync(readFileSync(tgzPath));
  const entries = new Set<string>();
  let manifest: Record<string, unknown> | null = null;
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    // Two zero blocks signal end of archive.
    if (header.every((byte) => byte === 0)) break;

    const nameRaw = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefixRaw = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const fullName = prefixRaw ? `${prefixRaw}/${nameRaw}` : nameRaw;
    const sizeOctal = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = sizeOctal ? Number.parseInt(sizeOctal, 8) : 0;
    const typeFlag = header[156];
    const dataStart = offset + 512;

    if (fullName && (typeFlag === 0 || typeFlag === 48) /* '0' */) {
      const normalized = fullName.replace(/^\.\//, "").replace(/^package\//, "");
      entries.add(normalized);
      if (normalized === "package.json") {
        manifest = JSON.parse(tar.subarray(dataStart, dataStart + size).toString("utf8")) as Record<
          string,
          unknown
        >;
      }
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return { entries, manifest };
}

export interface DistManifestCheckResult {
  importsByFile: Record<string, string[]>;
  errors: string[];
}

function runtimeForBundle(file: string, pkgName: string): TargetRuntime {
  if (file === "sweep-ui.js" || pkgName === "@opentui/core") return "bun";
  return "node";
}

function normalizeDistRelative(distDir: string, fromFile: string, target: string): string {
  const resolved = resolve(dirname(join(distDir, fromFile)), target);
  const relFromDist = relative(distDir, resolved).replace(/\\/g, "/");
  return posix.normalize(`dist/${relFromDist}`);
}

/**
 * Verify every `dist/*.js` bundle (and optional packed tarball entry set) against
 * the packed manifest:
 * - Every `exports`/`bin` target in the packed manifest exists in `dist/` (and in the tarball).
 * - Every bare package import is declared in `dependencies` or `optionalDependencies`.
 * - Every complete external specifier (including subpaths) resolves under its target runtime's conditions.
 * - Every declared range satisfies the built package version, and `@opentui/core` exports all named imports.
 * - Every relative import and `new URL("./...", import.meta.url)` sibling target exists in `dist/` (and the tarball).
 * - `#...` subpath imports must be declared in `packedManifest.imports` (never misclassified as npm packages).
 * - `data:` / `file:` / URL imports are not misclassified as npm packages.
 * - Every computed `import(...)` / `require(...)` must be explicitly covered.
 */
export function verifyDistAgainstManifest(options: {
  distDir: string;
  packedManifest: Record<string, unknown>;
  /** Optional package-relative paths present in the packed tarball (e.g. `dist/sweep.js`). */
  tarballEntries?: ReadonlySet<string>;
  /** Explicit allowlist for computed `import(...)` / `require(...)` calls. */
  allowedComputedImports?: readonly ComputedImportRule[];
  /** Node binary path for resolving Node-target external specifiers. */
  nodeBin?: string;
  resolveInstalled?: (
    specifier: string,
    fromDir: string,
    runtime: TargetRuntime,
  ) => InstalledPackageResolution | null;
}): DistManifestCheckResult {
  const { distDir, packedManifest, tarballEntries } = options;
  const allowedComputed = options.allowedComputedImports ?? DEFAULT_COMPUTED_IMPORT_RULES;
  const nodeBin = options.nodeBin ?? "node";
  const resolveInstalled =
    options.resolveInstalled ??
    ((
      specifier: string,
      fromDir: string,
      runtime: TargetRuntime,
    ): InstalledPackageResolution | null => {
      const pkgName = barePackageName(specifier);
      if (!pkgName) return null;
      const entryPath = resolveExternalSpecifier(specifier, fromDir, runtime, nodeBin);
      if (!entryPath) return null;
      const info = findOwningPackageInfo(entryPath, pkgName);
      if (!info) return null;
      return {
        entryPath,
        version: info.version,
        ...(pkgName === "@opentui/core" && specifier === "@opentui/core"
          ? { exports: collectBunModuleExports(entryPath) }
          : {}),
      };
    });

  const deps = (packedManifest.dependencies as Record<string, string> | undefined) ?? {};
  const optionalDeps =
    (packedManifest.optionalDependencies as Record<string, string> | undefined) ?? {};
  const declared: Record<string, string> = { ...optionalDeps, ...deps };
  const manifestImports = (packedManifest.imports as Record<string, unknown> | undefined) ?? {};

  const files = readdirSync(distDir)
    .filter((file) => file.endsWith(".js") || file.endsWith(".mjs"))
    .sort();
  const importsByFile: Record<string, string[]> = {};
  const externalChecks = new Map<
    string,
    { file: string; specifier: string; pkg: string; runtime: TargetRuntime }
  >();
  const errors: string[] = [];

  // 1. Verify every exports/bin target advertised by the packed manifest exists.
  const entryTargets = collectManifestEntryTargets(packedManifest);
  for (const target of entryTargets) {
    if (tarballEntries && !tarballEntries.has(target)) {
      errors.push(`packed tarball is missing manifest entry target "${target}"`);
    }
    if (target.startsWith("dist/")) {
      const onDisk = join(distDir, target.slice("dist/".length));
      if (!existsSync(onDisk)) {
        errors.push(`manifest entry target "${target}" does not exist on disk at ${onDisk}`);
      }
    }
  }

  // 2. Inspect every bundle in dist/.
  for (const file of files) {
    const source = readFileSync(join(distDir, file), "utf8");
    const refs = scanBundleRuntimeReferences(source);
    importsByFile[file] = refs.barePackages;

    for (const specifier of refs.externalSpecifiers) {
      const pkg = barePackageName(specifier);
      if (!pkg) continue;
      if (!(pkg in declared)) {
        errors.push(
          `dist/${file} imports "${specifier}" (package "${pkg}"), which is not declared in packed dependencies or optionalDependencies`,
        );
        continue;
      }
      const runtime = runtimeForBundle(file, pkg);
      const key = `${runtime}\0${specifier}`;
      if (!externalChecks.has(key)) {
        externalChecks.set(key, { file, specifier, pkg, runtime });
      }
    }

    for (const sub of refs.subpathImports) {
      if (!(sub in manifestImports)) {
        errors.push(
          `dist/${file} uses package subpath import "${sub}", which is not declared in packed manifest "imports"`,
        );
      }
    }

    // Validate all relative imports and `new URL("./...", import.meta.url)` sibling targets.
    for (const relTarget of [...refs.relativeImports, ...refs.urlSiblings]) {
      const resolvedOnDisk = resolve(dirname(join(distDir, file)), relTarget);
      if (!existsSync(resolvedOnDisk)) {
        errors.push(
          `dist/${file} references missing sibling target "${relTarget}" (expected at ${resolvedOnDisk})`,
        );
      }
      if (tarballEntries) {
        const tarPath = normalizeDistRelative(distDir, file, relTarget);
        if (!tarballEntries.has(tarPath)) {
          errors.push(
            `dist/${file} references sibling target "${relTarget}" ("${tarPath}"), which is missing from packed tarball`,
          );
        }
      }
    }

    // Require explicit coverage for every computed `import(...)` / `require(...)`.
    for (const call of refs.computedImports) {
      const covered = allowedComputed.some(
        (rule) =>
          rule.file === file &&
          rule.kind === call.kind &&
          rule.matches(call.expression, { source, urlSiblings: refs.urlSiblings }),
      );
      if (!covered) {
        errors.push(`dist/${file} contains uncovered computed ${call.kind}(${call.expression})`);
      }
    }
  }

  // 3. Resolve every complete external specifier under its target runtime's conditions.
  for (const { file, specifier, pkg, runtime } of externalChecks.values()) {
    const range = declared[pkg];
    if (!range) continue;
    const installed = resolveInstalled(specifier, distDir, runtime);
    if (!installed) {
      errors.push(
        `unable to resolve runtime import target "${specifier}" (from dist/${file}) under ${runtime} conditions`,
      );
      continue;
    }
    if (!Bun.semver.satisfies(installed.version, range)) {
      errors.push(
        `packed manifest declares "${pkg}": "${range}", which does not satisfy built version ${installed.version}`,
      );
    }
    if (specifier === "@opentui/core" && files.includes("sweep-ui.js")) {
      const uiSource = readFileSync(join(distDir, "sweep-ui.js"), "utf8");
      const required = extractNamedImportsFromPackage(uiSource, "@opentui/core");
      if (required.length === 0) {
        errors.push(`dist/sweep-ui.js has no named imports from "@opentui/core"`);
      } else if (installed.exports) {
        const missing = required.filter((name) => !installed.exports!.has(name));
        if (missing.length > 0) {
          errors.push(
            `built "@opentui/core"@${installed.version} is missing exports required by dist/sweep-ui.js: ${missing.join(", ")}`,
          );
        }
      }
    }
  }

  return { importsByFile, errors };
}
