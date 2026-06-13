import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import {
  currentNativePlatformId,
  NATIVE_PLATFORM_NPM_NAMES,
  NATIVE_PLATFORMS,
  nativePlatformById,
} from "./native-platforms.js";
import { sweepPackageRoot } from "./rust-engine.js";

describe("native platforms", () => {
  test("defines five platform packages", () => {
    expect(NATIVE_PLATFORMS).toHaveLength(5);
    expect(NATIVE_PLATFORM_NPM_NAMES).toEqual([
      "@kitsunekode/sweep-engine-linux-64",
      "@kitsunekode/sweep-engine-linux-arm64",
      "@kitsunekode/sweep-engine-darwin-64",
      "@kitsunekode/sweep-engine-darwin-arm64",
      "@kitsunekode/sweep-engine-windows-64",
    ]);
  });

  test("currentNativePlatformId matches host when supported", () => {
    const id = currentNativePlatformId();
    if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
      expect(id).toBe(process.arch === "x64" ? "linux-64" : "linux-arm64");
    }
    if (id) {
      expect(nativePlatformById(id)?.npmName).toMatch(/^@kitsunekode\/sweep-engine-/);
    }
  });
});

describe("sweepPackageRoot", () => {
  test("resolves repo root from packages/core/src", () => {
    const coreSrc = resolve(import.meta.dir);
    const root = sweepPackageRoot(coreSrc);
    expect(root.endsWith("/sweep") || root.endsWith("\\sweep")).toBe(true);
  });

  test("resolves package root from dist layout", () => {
    const fakeDistDir = resolve("/tmp/sweep-pkg/dist");
    expect(sweepPackageRoot(fakeDistDir)).toBe(resolve("/tmp/sweep-pkg"));
    const fakeDistFile = resolve("/tmp/sweep-pkg/dist/sweep.js");
    expect(sweepPackageRoot(dirname(fakeDistFile))).toBe(resolve("/tmp/sweep-pkg"));
  });
});
