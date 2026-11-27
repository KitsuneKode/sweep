import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  barePackageName,
  extractBarePackageImports,
  extractNamedImportsFromPackage,
  findReactDevMarkers,
  resolveExternalSpecifier,
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
    const pkgDir = join(dir, "node_modules", "@opentui", "core");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@opentui/core",
        version: "0.6.8",
        type: "module",
        exports: {
          ".": "./index.js",
          "./valid-subpath": "./valid.js",
        },
      }),
    );
    writeFileSync(join(pkgDir, "index.js"), "export const ok = 1;\n");
    writeFileSync(join(pkgDir, "valid.js"), "export const valid = 1;\n");

    writeFileSync(
      join(dir, "sweep-ui.js"),
      'import { valid } from "@opentui/core/valid-subpath";\nvoid valid;\n',
    );
    const validRes = verifyDistAgainstManifest({
      distDir: dir,
      packedManifest: {
        optionalDependencies: { "@opentui/core": "^0.6.8" },
      },
    });
    expect(validRes.errors).toEqual([]);

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

  test("Node resolver anchors at supplied parent dir and rejects exported subpaths whose target file is absent", () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "sweep-node-resolve-"));
    roots.push(pkgRoot);
    const distDir = join(pkgRoot, "dist");
    const depDir = join(pkgRoot, "node_modules", "local-only-pkg");
    mkdirSync(distDir, { recursive: true });
    mkdirSync(depDir, { recursive: true });
    writeFileSync(
      join(depDir, "package.json"),
      JSON.stringify({
        name: "local-only-pkg",
        version: "1.2.3",
        type: "module",
        exports: {
          ".": "./index.mjs",
          "./sub": "./sub.mjs",
          "./missing": "./does-not-exist.mjs",
        },
      }),
    );
    writeFileSync(join(depDir, "index.mjs"), "export const ok = 1;\n");
    writeFileSync(join(depDir, "sub.mjs"), "export const sub = 2;\n");

    // Valid targets visible only from pkgRoot/dist must resolve under Node.
    const resolvedRoot = resolveExternalSpecifier("local-only-pkg", distDir, "node");
    expect(resolvedRoot).not.toBeNull();
    expect(realpathSync(resolvedRoot!)).toBe(realpathSync(join(depDir, "index.mjs")));
    const resolvedSub = resolveExternalSpecifier("local-only-pkg/sub", distDir, "node");
    expect(resolvedSub).not.toBeNull();
    expect(realpathSync(resolvedSub!)).toBe(realpathSync(join(depDir, "sub.mjs")));
    // Declared export pointing to an absent file must not resolve.
    expect(resolveExternalSpecifier("local-only-pkg/missing", distDir, "node")).toBeNull();

    // End-to-end contract check: absent subpath fails, existing subpath passes.
    writeFileSync(
      join(distDir, "sweep.js"),
      '#!/usr/bin/env node\nimport { nope } from "local-only-pkg/missing";\nvoid nope;\n',
    );
    const missingRes = verifyDistAgainstManifest({
      distDir,
      packedManifest: { dependencies: { "local-only-pkg": "^1.0.0" } },
    });
    expect(
      missingRes.errors.some(
        (e) => e.includes("local-only-pkg/missing") && e.includes("node conditions"),
      ),
    ).toBe(true);

    writeFileSync(
      join(distDir, "sweep.js"),
      '#!/usr/bin/env node\nimport { sub } from "local-only-pkg/sub";\nvoid sub;\n',
    );
    const okRes = verifyDistAgainstManifest({
      distDir,
      packedManifest: { dependencies: { "local-only-pkg": "^1.0.0" } },
    });
    expect(okRes.errors).toEqual([]);
  });

  test("extractNamedImportsFromPackage ignores commented-out imports", () => {
    const source = [
      '/* import { Imaginary } from "@opentui/core"; */',
      '// import { AlsoFake } from "@opentui/core";',
      'import { BoxRenderable, TextRenderable as T } from "@opentui/core";',
    ].join("\n");
    expect(extractNamedImportsFromPackage(source, "@opentui/core")).toEqual([
      "BoxRenderable",
      "TextRenderable",
    ]);
  });

  test("verifyDistAgainstManifest handles query params on relative imports, wildcard #imports, optionalDependencies precedence, and nested computed imports in new URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-dist-minor-edges-"));
    roots.push(dir);
    writeFileSync(join(dir, "chunk.js"), "export const x = 1;\n");
    writeFileSync(
      join(dir, "sweep.js"),
      '#!/usr/bin/env node\nimport "./chunk.js?mode=fast";\nimport "#internal/chunk";\n',
    );
    const okRes = verifyDistAgainstManifest({
      distDir: dir,
      packedManifest: {
        imports: { "#internal/*": "./dist/*.js" },
      },
      tarballEntries: new Set(["dist/sweep.js", "dist/chunk.js"]),
    });
    expect(okRes.errors).toEqual([]);

    const missingTarget = verifyDistAgainstManifest({
      distDir: dir,
      packedManifest: {
        imports: { "#internal/*": "./dist/missing-*.js" },
      },
      tarballEntries: new Set(["dist/sweep.js", "dist/chunk.js"]),
    });
    expect(missingTarget.errors.some((e) => e.includes("#internal/chunk"))).toBe(true);

    writeFileSync(
      join(dir, "sweep.js"),
      "#!/usr/bin/env node\nconst u = new URL(String(import(target)), import.meta.url);\nvoid u;\n",
    );
    const computedInUrl = verifyDistAgainstManifest({
      distDir: dir,
      packedManifest: {},
    });
    expect(computedInUrl.errors.some((e) => e.includes("uncovered computed import(target)"))).toBe(
      true,
    );

    writeFileSync(join(dir, "sweep.js"), '#!/usr/bin/env node\nimport "pkg-a";\n');
    const prec = verifyDistAgainstManifest({
      distDir: dir,
      packedManifest: {
        dependencies: { "pkg-a": "^1.0.0" },
        optionalDependencies: { "pkg-a": "^2.0.0" },
      },
      resolveInstalled: () => ({ entryPath: "/fake/pkg-a/index.js", version: "2.3.0" }),
    });
    expect(prec.errors).toEqual([]);
  });
});
