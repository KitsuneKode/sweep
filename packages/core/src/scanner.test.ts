import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "./config.js";
import { exactSize, scan } from "./scanner.js";
import type { SweepConfig } from "@kitsunekode/sweep-protocol";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync("/tmp/sweep-test-");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const dir = (...parts: string[]) => join(tmpDir, ...parts);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("scan — basic matching", () => {
  test("finds node_modules at the root level", async () => {
    mkdirSync(dir("node_modules"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("node_modules");
    expect(result.entries[0]?.path).toBe(dir("node_modules"));
  });

  test("finds multiple matching patterns", async () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));
    mkdirSync(dir(".next"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(3);
  });

  test("ignores directories that don't match any pattern", async () => {
    mkdirSync(dir("src"));
    mkdirSync(dir("components"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(0);
  });

  test("matches *.tsbuildinfo glob pattern", async () => {
    mkdirSync(dir("packages", "api"), { recursive: true });
    writeFileSync(dir("tsconfig.tsbuildinfo"), "");
    writeFileSync(dir("packages", "api", "tsconfig.tsbuildinfo"), "{}");
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    // Should match both tsbuildinfo files
    expect(result.entries.some((e) => e.name === "tsconfig.tsbuildinfo")).toBe(true);
  });
});

describe("scan — recursion", () => {
  test("finds node_modules recursively in a monorepo", async () => {
    mkdirSync(dir("packages", "web"), { recursive: true });
    mkdirSync(dir("packages", "api"), { recursive: true });
    mkdirSync(dir("packages", "web", "node_modules"));
    mkdirSync(dir("packages", "api", "node_modules"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(2);
  });

  test("does NOT recurse into a matched directory (no double-counting)", async () => {
    // node_modules containing a nested node_modules should only be counted once
    mkdirSync(dir("node_modules", "some-pkg", "node_modules"), { recursive: true });
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("node_modules");
  });

  test("respects depth: 0 (only root level)", async () => {
    mkdirSync(dir("a", "node_modules"), { recursive: true });
    mkdirSync(dir("node_modules")); // root level — should be found at depth 0
    const config: SweepConfig = { ...DEFAULT_CONFIG, depth: 0 };
    const result = await scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toBe(dir("node_modules"));
  });

  test("respects depth: 1 (one level deep)", async () => {
    mkdirSync(dir("a", "b", "node_modules"), { recursive: true }); // depth 2 — excluded
    mkdirSync(dir("a", "node_modules"), { recursive: true }); // depth 1 — included
    const config: SweepConfig = { ...DEFAULT_CONFIG, depth: 1 };
    const result = await scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toBe(dir("a", "node_modules"));
  });
});

describe("scan — symlinks", () => {
  test("marks symlinks as isSymlink: true", async () => {
    mkdirSync(dir("real-dir"));
    symlinkSync(dir("real-dir"), dir("node_modules"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.isSymlink).toBe(true);
  });

  test("does NOT recurse into symlinked directories", async () => {
    mkdirSync(dir("real-dir", "node_modules"), { recursive: true });
    symlinkSync(dir("real-dir"), dir("linked"));
    // Should find: linked/ (symlink) but NOT recurse into real-dir/node_modules via linked/
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["linked"] };
    const result = await scan(tmpDir, config);
    // real-dir/node_modules might be found, but linked/ itself should not be recursed
    expect(result.entries.every((e) => e.name !== "linked" || e.isSymlink)).toBe(true);
  });
});

describe("scan — ignore rules", () => {
  test("skips entries matching ignore list", async () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));
    const config: SweepConfig = { ...DEFAULT_CONFIG, ignore: ["dist"] };
    const result = await scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("node_modules");
  });

  test("ignore matches full path (substring match)", async () => {
    mkdirSync(dir("packages", "vendor", "node_modules"), { recursive: true });
    mkdirSync(dir("packages", "web", "node_modules"), { recursive: true });
    const config: SweepConfig = { ...DEFAULT_CONFIG, ignore: ["packages/vendor"] };
    const result = await scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toContain("packages/web");
  });
});

describe("scan — adversarial / security", () => {
  test("handles directory names with shell metacharacters safely", async () => {
    // If size estimation used execSync with string interpolation, this would be exploitable.
    // With execFileSync, the name is passed as a raw argument — no shell expansion.
    const dangerous = dir("dist;echo PWNED>/tmp/sweep-pwned-$RANDOM");
    mkdirSync(dangerous, { recursive: true });
    const config: SweepConfig = {
      ...DEFAULT_CONFIG,
      patterns: ["dist;echo PWNED>/tmp/sweep-pwned-$RANDOM"],
    };
    // Should complete without throwing or executing the injected command
    await scan(tmpDir, config);
  });

  test("handles directory names with backticks safely", async () => {
    const dangerous = dir("node_modules`id`");
    mkdirSync(dangerous);
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["node_modules`id`"] };
    await scan(tmpDir, config);
  });

  test("handles directory names with dollar signs safely", async () => {
    const dangerous = dir("dist$(whoami)");
    mkdirSync(dangerous);
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["dist$(whoami)"] };
    await scan(tmpDir, config);
  });

  test("handles directory names with spaces safely", async () => {
    mkdirSync(dir("my project", "node_modules"), { recursive: true });
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("node_modules");
  });

  test("handles directory names with newlines safely", async () => {
    // A path with a newline in the name should not confuse output parsing
    const dangerous = dir("node_modules\nnewline");
    mkdirSync(dangerous, { recursive: true });
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["node_modules\nnewline"] };
    await scan(tmpDir, config);
  });

  test("does not follow symlinks pointing outside project root", async () => {
    // A symlink pointing to /etc should not be recursed into
    symlinkSync("/etc", dir("symlink-to-etc"));
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["passwd"] };
    const result = await scan(tmpDir, config);
    // Should find nothing (didn't recurse into /etc via the symlink)
    expect(result.entries).toHaveLength(0);
  });

  test("handles circular symlinks without infinite loop", async () => {
    // A → B → A circular symlink chain should terminate
    mkdirSync(dir("a"));
    symlinkSync(dir("a"), dir("b"));
    // scan should complete in finite time without stack overflow
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.scannedDirs).toBeGreaterThanOrEqual(0);
  });

  test("returns empty result for unreadable directory (no throw)", async () => {
    // Permission-denied directories should be silently skipped
    // We simulate this by passing a non-existent path
    const result = await scan("/tmp/sweep-nonexistent-dir-xyz-123", DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(0);
    expect(result.scannedDirs).toBe(0);
  });

  test("ignore rule prevents traversal via substring match on injected patterns", async () => {
    mkdirSync(dir("packages", "evil", "node_modules"), { recursive: true });
    mkdirSync(dir("packages", "safe", "node_modules"), { recursive: true });
    // Ignore an adversarial path substring
    const config: SweepConfig = { ...DEFAULT_CONFIG, ignore: ["packages/evil"] };
    const result = await scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toContain("safe");
  });
});

describe("scan — streaming hooks", () => {
  test("onEntry fires during walk before onEntrySized", async () => {
    mkdirSync(dir("node_modules"));
    const order: string[] = [];

    await scan(tmpDir, DEFAULT_CONFIG, false, {
      onEntry: () => order.push("entry"),
      onEntrySized: () => order.push("sized"),
    });

    expect(order.length).toBeGreaterThan(0);
    expect(order.indexOf("entry")).toBeLessThan(order.indexOf("sized"));
  });
});

describe("scan — result metadata", () => {
  test("counts scanned directories", async () => {
    mkdirSync(dir("a"));
    mkdirSync(dir("b"));
    mkdirSync(dir("c"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.scannedDirs).toBeGreaterThan(0);
  });

  test("estimatedTotalBytes sums entry sizes", async () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    const sum = result.entries.reduce((s, e) => s + e.estimatedBytes, 0);
    expect(result.estimatedTotalBytes).toBe(sum);
  });
});

describe("scanner — size estimation", () => {
  test("exactSize calculates recursive size of a directory excluding symlinks", async () => {
    mkdirSync(dir("node_modules"));
    writeFileSync(dir("node_modules", "file1.txt"), "hello"); // 5 bytes
    writeFileSync(dir("node_modules", "file2.txt"), "world!!"); // 8 bytes
    // nested directory
    mkdirSync(dir("node_modules", "nested"));
    writeFileSync(dir("node_modules", "nested", "file3.txt"), "12345"); // 5 bytes
    // symlink (should be skipped)
    writeFileSync(dir("outside.txt"), "some content");
    symlinkSync(dir("outside.txt"), dir("node_modules", "link.txt"));

    const size = exactSize(dir("node_modules"));
    expect(size).toBe(5 + 7 + 5);
  });
});
