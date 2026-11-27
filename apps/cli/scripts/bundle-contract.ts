/**
 * Build-time and preflight contract helpers for verifying `dist/` bundles
 * against the packed npm manifest and installed dependency versions/exports.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";

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

export function stripShebang(source: string): string {
  return source.startsWith("#!") ? source.replace(/^#![^\r\n]*\r?\n?/, "") : source;
}

/** Extract the npm package name from a bare specifier (`@scope/pkg/sub` -> `@scope/pkg`). */
export function barePackageName(specifier: string): string | null {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("\\") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    specifier === "bun" ||
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

/** Return sorted unique bare npm package names imported by a JS bundle. */
export function extractBarePackageImports(source: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: "js" });
  const imports = transpiler.scanImports(stripShebang(source));
  const packages = new Set<string>();
  for (const entry of imports) {
    const pkg = barePackageName(entry.path);
    if (pkg) packages.add(pkg);
  }
  return [...packages].sort();
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

export interface InstalledPackageResolution {
  entryPath: string;
  version: string;
  exports?: ReadonlySet<string>;
}

export interface DistManifestCheckResult {
  importsByFile: Record<string, string[]>;
  errors: string[];
}

/**
 * Compare every bare package import in `dist/*.js` against the packed manifest's
 * `dependencies` and `optionalDependencies`, verify declared ranges include the
 * built versions, and confirm `@opentui/core` exports every named import used by
 * `dist/sweep-ui.js`.
 */
export function verifyDistAgainstManifest(options: {
  distDir: string;
  packedManifest: Record<string, unknown>;
  resolveInstalled?: (pkgName: string, fromDir: string) => InstalledPackageResolution | null;
}): DistManifestCheckResult {
  const { distDir, packedManifest } = options;
  const resolveInstalled =
    options.resolveInstalled ??
    ((pkgName: string, fromDir: string): InstalledPackageResolution | null => {
      try {
        const entryPath = Bun.resolveSync(pkgName, fromDir);
        const info = findOwningPackageInfo(entryPath, pkgName);
        if (!info) return null;
        return {
          entryPath,
          version: info.version,
          exports: collectBunModuleExports(entryPath),
        };
      } catch {
        return null;
      }
    });

  const deps = (packedManifest.dependencies as Record<string, string> | undefined) ?? {};
  const optionalDeps =
    (packedManifest.optionalDependencies as Record<string, string> | undefined) ?? {};
  const declared: Record<string, string> = { ...optionalDeps, ...deps };

  const files = readdirSync(distDir)
    .filter((file) => file.endsWith(".js") || file.endsWith(".mjs"))
    .sort();
  const importsByFile: Record<string, string[]> = {};
  const allPackages = new Set<string>();
  const errors: string[] = [];

  for (const file of files) {
    const source = readFileSync(join(distDir, file), "utf8");
    const bare = extractBarePackageImports(source);
    importsByFile[file] = bare;
    for (const pkg of bare) {
      allPackages.add(pkg);
      if (!(pkg in declared)) {
        errors.push(
          `dist/${file} imports "${pkg}", which is not declared in packed dependencies or optionalDependencies`,
        );
      }
    }
  }

  for (const pkg of [...allPackages].sort()) {
    const range = declared[pkg];
    if (!range) continue;
    const installed = resolveInstalled(pkg, distDir);
    if (!installed) {
      errors.push(`unable to resolve built package "${pkg}" from ${distDir}`);
      continue;
    }
    if (!Bun.semver.satisfies(installed.version, range)) {
      errors.push(
        `packed manifest declares "${pkg}": "${range}", which does not satisfy built version ${installed.version}`,
      );
    }
    if (pkg === "@opentui/core" && files.includes("sweep-ui.js")) {
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
