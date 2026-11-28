import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REBUILD_COST_META, packageManager, rebuildFor } from "./rebuild.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("rebuild cost classification", () => {
  test("classifies caches, installs, builds, and custom opt-in patterns", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-rebuild-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "bun.lock"), "");
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = 'demo'\n");

    expect(packageManager(dir)).toBe("bun");
    expect(rebuildFor(".turbo", dir)).toEqual({ cost: "cache", how: "turbo refills it" });
    expect(rebuildFor("node_modules", dir)).toEqual({ cost: "install", how: "bun install" });
    expect(rebuildFor("target", dir)).toEqual({ cost: "build", how: "cargo build" });
    expect(rebuildFor("custom", dir, ".venv")).toEqual({
      cost: "custom",
      how: "virtualenv - slow to recreate",
    });
    expect(rebuildFor("custom", dir, "my-scratch")).toEqual({
      cost: "custom",
      how: "your pattern",
    });
  });

  test("exposes labels and hints for all four rebuild costs", () => {
    expect(REBUILD_COST_META.cache.label).toBe("Caches");
    expect(REBUILD_COST_META.install.label).toBe("Installs");
    expect(REBUILD_COST_META.build.label).toBe("Builds");
    expect(REBUILD_COST_META.custom.label).toBe("Opt-in");
  });
});
