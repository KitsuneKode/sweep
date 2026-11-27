import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectStaticModuleExports,
  inspectOpenTui,
  satisfiesSemverRange,
  verifyOpenTuiAvailable,
} from "./opentui-check.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFakeOpenTui(options: { version: string; exportsCode: string }): string {
  const root = mkdtempSync(join(tmpdir(), "sweep-opentui-check-"));
  roots.push(root);
  const pkgDir = join(root, "node_modules", "@opentui", "core");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@opentui/core", version: options.version, type: "module" }),
  );
  const entry = join(pkgDir, "index.js");
  writeFileSync(entry, options.exportsCode);
  return entry;
}

describe("satisfiesSemverRange", () => {
  test("matches caret ranges for 0.x and >=1.x versions", () => {
    expect(satisfiesSemverRange("0.6.8", "^0.6.8")).toBe(true);
    expect(satisfiesSemverRange("0.6.12", "^0.6.8")).toBe(true);
    expect(satisfiesSemverRange("0.6.7", "^0.6.8")).toBe(false);
    expect(satisfiesSemverRange("0.7.0", "^0.6.8")).toBe(false);
    expect(satisfiesSemverRange("0.1.97", "^0.6.8")).toBe(false);
    expect(satisfiesSemverRange("1.5.0", "^1.2.3")).toBe(true);
    expect(satisfiesSemverRange("2.0.0", "^1.2.3")).toBe(false);
  });

  test("handles comparators and OR ranges", () => {
    expect(satisfiesSemverRange("0.6.9", ">=0.6.8 <0.7.0")).toBe(true);
    expect(satisfiesSemverRange("0.7.0", ">=0.6.8 <0.7.0")).toBe(false);
    expect(satisfiesSemverRange("0.7.0", "^0.6.8 || ^0.7.0")).toBe(true);
  });
});

describe("inspectOpenTui & verifyOpenTuiAvailable", () => {
  const requiredExports = ["ImageRenderable", "createCliRenderer", "StyledText"];

  test("passes when resolved version satisfies range and exports every required symbol", async () => {
    const entry = createFakeOpenTui({
      version: "0.6.8",
      exportsCode: `export class ImageRenderable {}\nexport function createCliRenderer() {}\nexport class StyledText {}\n`,
    });
    const result = await verifyOpenTuiAvailable({
      resolvers: [() => entry],
      requiredRange: "^0.6.8",
      requiredExports,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe("0.6.8");
      expect(result.resolvedPath).toBe(entry);
    }
  });

  test("fails with resolved path, version, missing exports, and fixes on old 0.1.97 core", async () => {
    const entry = createFakeOpenTui({
      version: "0.1.97",
      exportsCode: `export function createCliRenderer() {}\n`,
    });
    const result = await verifyOpenTuiAvailable({
      resolvers: [() => entry],
      requiredRange: "^0.6.8",
      requiredExports,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("version_mismatch");
      expect(result.version).toBe("0.1.97");
      expect(result.resolvedPath).toBe(entry);
      expect(result.missingExports).toEqual(["ImageRenderable", "StyledText"]);
      expect(result.message).toContain(entry);
      expect(result.message).toContain("0.1.97");
      expect(result.message).toContain("ImageRenderable");
      expect(result.message).toContain("bunx @kitsunekode/sweep ui");
      expect(result.message).toContain("standalone");
    }
  });

  test("fails when version matches range but a required export is missing", async () => {
    const entry = createFakeOpenTui({
      version: "0.6.8",
      exportsCode: `export function createCliRenderer() {}\nexport class StyledText {}\n`,
    });
    const result = inspectOpenTui({
      resolvers: [() => entry],
      requiredRange: "^0.6.8",
      requiredExports,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing_exports");
      expect(result.missingExports).toEqual(["ImageRenderable"]);
      expect(result.message).toContain("ImageRenderable");
      expect(result.message).toContain(entry);
    }
  });

  test("follows local wildcard re-exports when statically scanning exports", () => {
    const entry = createFakeOpenTui({
      version: "0.6.8",
      exportsCode: `export * from "./extra.js";\nexport { createCliRenderer };\nfunction createCliRenderer() {}\n`,
    });
    writeFileSync(
      join(entry, "..", "extra.js"),
      `const img = 1; export { img as ImageRenderable }; export class StyledText {}\n`,
    );
    const exports = collectStaticModuleExports(entry);
    expect(exports?.has("ImageRenderable")).toBe(true);
    expect(exports?.has("createCliRenderer")).toBe(true);
    expect(exports?.has("StyledText")).toBe(true);
  });

  test("reports load_error cleanly when runtime import fails", async () => {
    const entry = createFakeOpenTui({
      version: "0.6.8",
      exportsCode: `export class ImageRenderable {}\nexport function createCliRenderer() {}\nexport class StyledText {}\n`,
    });
    const result = await verifyOpenTuiAvailable({
      resolvers: [() => entry],
      requiredRange: "^0.6.8",
      requiredExports,
      loadModule: async () => {
        throw new Error("dlopen failed: libopentui.so not found");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("load_error");
      expect(result.message).toContain("dlopen failed");
      expect(result.message).toContain(entry);
      expect(result.message).toContain("0.6.8");
    }
  });
});
