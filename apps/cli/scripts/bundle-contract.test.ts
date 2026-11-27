import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractBarePackageImports,
  extractNamedImportsFromPackage,
  findReactDevMarkers,
  verifyDistAgainstManifest,
} from "./bundle-contract.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bundle-contract", () => {
  test("extractBarePackageImports ignores builtins and relative imports and normalizes subpaths", () => {
    const source = [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      'import path from "path";',
      'import { dlopen } from "bun:ffi";',
      'import "./sweep-ui.js";',
      'import { ImageRenderable } from "@opentui/core";',
      'import foo from "@scope/pkg/sub/path";',
      'import bar from "plain-pkg/utils";',
    ].join("\n");
    expect(extractBarePackageImports(source)).toEqual(["@opentui/core", "@scope/pkg", "plain-pkg"]);
  });

  test("extractNamedImportsFromPackage handles minified imports and aliases", () => {
    const source =
      'import{ImageRenderable as ImageRenderable2,StyledText}from"@opentui/core";import def,{createCliRenderer}from"@opentui/core";';
    expect(extractNamedImportsFromPackage(source, "@opentui/core")).toEqual([
      "ImageRenderable",
      "StyledText",
      "createCliRenderer",
    ]);
  });

  test("findReactDevMarkers detects jsxDEV and runWithFiberInDEV", () => {
    expect(findReactDevMarkers("const a = jsx('box', {});")).toEqual([]);
    expect(findReactDevMarkers("jsxDEV('box', {}); runWithFiberInDEV();")).toEqual([
      "jsxDEV",
      "runWithFiberInDEV",
    ]);
  });

  test("verifyDistAgainstManifest fails on undeclared imports and mismatched ranges/exports", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-dist-contract-"));
    roots.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sweep.js"), '#!/usr/bin/env node\nimport "node:fs";\n');
    writeFileSync(
      join(dir, "sweep-ui.js"),
      'import{ImageRenderable,createCliRenderer}from"@opentui/core";import"ws";\n',
    );

    const res = verifyDistAgainstManifest({
      distDir: dir,
      packedManifest: {
        optionalDependencies: { "@opentui/core": "^0.2.16" },
      },
      resolveInstalled: (pkg) =>
        pkg === "@opentui/core"
          ? {
              entryPath: "/fake/@opentui/core/index.js",
              version: "0.6.8",
              exports: new Set(["createCliRenderer"]),
            }
          : null,
    });
    expect(res.errors.some((e) => e.includes('"ws"') && e.includes("not declared"))).toBe(true);
    expect(res.errors.some((e) => e.includes("^0.2.16") && e.includes("0.6.8"))).toBe(true);
    expect(res.errors.some((e) => e.includes("ImageRenderable"))).toBe(true);
  });

  test("verifyDistAgainstManifest passes when imports, ranges, and exports match", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-dist-contract-ok-"));
    roots.push(dir);
    writeFileSync(join(dir, "sweep.js"), '#!/usr/bin/env node\nimport "node:fs";\n');
    writeFileSync(
      join(dir, "sweep-ui.js"),
      'import{ImageRenderable,createCliRenderer}from"@opentui/core";\n',
    );

    const res = verifyDistAgainstManifest({
      distDir: dir,
      packedManifest: {
        optionalDependencies: { "@opentui/core": "^0.6.8" },
      },
      resolveInstalled: () => ({
        entryPath: "/fake/@opentui/core/index.js",
        version: "0.6.8",
        exports: new Set(["ImageRenderable", "createCliRenderer"]),
      }),
    });
    expect(res.errors).toEqual([]);
  });
});
