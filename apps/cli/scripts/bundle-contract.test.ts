import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  barePackageName,
  extractBarePackageImports,
  extractNamedImportsFromPackage,
  findReactDevMarkers,
  scanBundleRuntimeReferences,
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
      'import internal from "#internal";',
      'import dataMod from "data:text/javascript,export default 1";',
    ].join("\n");
    expect(extractBarePackageImports(source)).toEqual(["@opentui/core", "@scope/pkg", "plain-pkg"]);
    expect(barePackageName("#internal")).toBeNull();
    expect(barePackageName("data:text/javascript,export default 1")).toBeNull();
    expect(barePackageName("file:///tmp/x.js")).toBeNull();
    const refs = scanBundleRuntimeReferences(source);
    expect(refs.subpathImports).toEqual(["#internal"]);
    expect(refs.urlImports).toEqual(["data:text/javascript,export default 1"]);
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

  test("negative fixture: rejects missing exports/bin target in dist and tarball", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-dist-missing-lib-"));
    roots.push(dir);
    writeFileSync(join(dir, "sweep.js"), '#!/usr/bin/env node\nconsole.log("hi");\n');
    const res = verifyDistAgainstManifest({
      distDir: dir,
      packedManifest: {
        bin: { sweep: "dist/sweep.js" },
        exports: { ".": "./dist/sweep-lib.js", "./bin": "./dist/sweep.js" },
      },
      tarballEntries: new Set(["package.json", "dist/sweep.js"]),
    });
    expect(res.errors.some((e) => e.includes("dist/sweep-lib.js") && e.includes("tarball"))).toBe(
      true,
    );
    expect(res.errors.some((e) => e.includes("dist/sweep-lib.js") && e.includes("on disk"))).toBe(
      true,
    );
  });

  test("negative fixture: rejects uncovered computed import() and require()", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-dist-computed-"));
    roots.push(dir);
    writeFileSync(
      join(dir, "sweep.js"),
      '#!/usr/bin/env node\nconst target = "evil-pkg";\nawait import(target);\nconst r = (x) => require(x);\nvoid r;\n',
    );
    const res = verifyDistAgainstManifest({
      distDir: dir,
      packedManifest: {},
    });
    expect(res.errors.some((e) => e.includes("uncovered computed import(target)"))).toBe(true);
    expect(res.errors.some((e) => e.includes("uncovered computed require(x)"))).toBe(true);
  });

  test("negative fixture: rejects missing sibling through new URL(..., import.meta.url)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-dist-missing-sibling-"));
    roots.push(dir);
    writeFileSync(
      join(dir, "sweep.js"),
      '#!/usr/bin/env node\nconst u = new URL("./missing-chunk.js", import.meta.url).href;\nvoid u;\n',
    );
    const res = verifyDistAgainstManifest({
      distDir: dir,
      packedManifest: {},
      tarballEntries: new Set(["dist/sweep.js"]),
    });
    expect(res.errors.some((e) => e.includes("./missing-chunk.js") && e.includes("missing"))).toBe(
      true,
    );
  });

  test("negative fixture: rejects declared package with nonexistent subpath under real runtime conditions", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-dist-bad-subpath-"));
    roots.push(dir);
    writeFileSync(
      join(dir, "sweep-ui.js"),
      'import { nope } from "@opentui/core/does-not-exist-subpath";\nvoid nope;\n',
    );
    const res = verifyDistAgainstManifest({
      distDir: dir,
      packedManifest: {
        optionalDependencies: { "@opentui/core": "^0.6.8" },
      },
    });
    expect(
      res.errors.some(
        (e) => e.includes("@opentui/core/does-not-exist-subpath") && e.includes("bun conditions"),
      ),
    ).toBe(true);
  });

  test("negative fixture: #internal is checked against manifest imports, and data: is not a package", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-dist-subpath-data-"));
    roots.push(dir);
    writeFileSync(
      join(dir, "sweep.js"),
      '#!/usr/bin/env node\nimport "#internal";\nimport "data:text/javascript,export default 1";\n',
    );
    const undeclared = verifyDistAgainstManifest({
      distDir: dir,
      packedManifest: {},
    });
    expect(
      undeclared.errors.some((e) => e.includes("#internal") && e.includes('manifest "imports"')),
    ).toBe(true);
    expect(undeclared.errors.some((e) => e.includes("data:"))).toBe(false);

    const declared = verifyDistAgainstManifest({
      distDir: dir,
      packedManifest: { imports: { "#internal": "./dist/sweep.js" } },
    });
    expect(declared.errors).toEqual([]);
  });
});
