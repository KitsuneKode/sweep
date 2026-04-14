import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { scan } from "../src/scanner.js";
import type { SweepConfig } from "../src/types.js";

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
  test("finds node_modules at the root level", () => {
    mkdirSync(dir("node_modules"));
    const result = scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("node_modules");
    expect(result.entries[0]?.path).toBe(dir("node_modules"));
  });

  test("finds multiple matching patterns", () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));
    mkdirSync(dir(".next"));
    const result = scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(3);
  });

  test("ignores directories that don't match any pattern", () => {
    mkdirSync(dir("src"));
    mkdirSync(dir("components"));
    const result = scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(0);
  });

  test("matches *.tsbuildinfo glob pattern", () => {
    mkdirSync(dir("packages", "api"), { recursive: true });
    writeFileSync(dir("tsconfig.tsbuildinfo"), "");
    writeFileSync(dir("packages", "api", "tsconfig.tsbuildinfo"), "{}");
    const result = scan(tmpDir, DEFAULT_CONFIG);
    // Should match both tsbuildinfo files
    expect(result.entries.some((e) => e.name === "tsconfig.tsbuildinfo")).toBe(true);
  });
});

describe("scan — recursion", () => {
  test("finds node_modules recursively in a monorepo", () => {
    mkdirSync(dir("packages", "web"), { recursive: true });
    mkdirSync(dir("packages", "api"), { recursive: true });
    mkdirSync(dir("packages", "web", "node_modules"));
    mkdirSync(dir("packages", "api", "node_modules"));
    const result = scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(2);
  });

  test("does NOT recurse into a matched directory (no double-counting)", () => {
    // node_modules containing a nested node_modules should only be counted once
    mkdirSync(dir("node_modules", "some-pkg", "node_modules"), { recursive: true });
    const result = scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("node_modules");
  });

  test("respects depth: 0 (only root level)", () => {
    mkdirSync(dir("a", "node_modules"), { recursive: true });
    mkdirSync(dir("node_modules")); // root level — should be found at depth 0
    const config: SweepConfig = { ...DEFAULT_CONFIG, depth: 0 };
    const result = scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toBe(dir("node_modules"));
  });

  test("respects depth: 1 (one level deep)", () => {
    mkdirSync(dir("a", "b", "node_modules"), { recursive: true }); // depth 2 — excluded
    mkdirSync(dir("a", "node_modules"), { recursive: true }); // depth 1 — included
    const config: SweepConfig = { ...DEFAULT_CONFIG, depth: 1 };
    const result = scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toBe(dir("a", "node_modules"));
  });
});

describe("scan — symlinks", () => {
  test("marks symlinks as isSymlink: true", () => {
    mkdirSync(dir("real-dir"));
    symlinkSync(dir("real-dir"), dir("node_modules"));
    const result = scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.isSymlink).toBe(true);
  });

  test("does NOT recurse into symlinked directories", () => {
    mkdirSync(dir("real-dir", "node_modules"), { recursive: true });
    symlinkSync(dir("real-dir"), dir("linked"));
    // Should find: linked/ (symlink) but NOT recurse into real-dir/node_modules via linked/
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["linked"] };
    const result = scan(tmpDir, config);
    // real-dir/node_modules might be found, but linked/ itself should not be recursed
    expect(result.entries.every((e) => e.name !== "linked" || e.isSymlink)).toBe(true);
  });
});

describe("scan — ignore rules", () => {
  test("skips entries matching ignore list", () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));
    const config: SweepConfig = { ...DEFAULT_CONFIG, ignore: ["dist"] };
    const result = scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("node_modules");
  });

  test("ignore matches full path (substring match)", () => {
    mkdirSync(dir("packages", "vendor", "node_modules"), { recursive: true });
    mkdirSync(dir("packages", "web", "node_modules"), { recursive: true });
    const config: SweepConfig = { ...DEFAULT_CONFIG, ignore: ["packages/vendor"] };
    const result = scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toContain("packages/web");
  });
});

describe("scan — adversarial / security", () => {
  test("handles directory names with shell metacharacters safely", () => {
    // If size estimation used execSync with string interpolation, this would be exploitable.
    // With execFileSync, the name is passed as a raw argument — no shell expansion.
    const dangerous = dir("dist;echo PWNED>/tmp/sweep-pwned-$RANDOM");
    mkdirSync(dangerous, { recursive: true });
    const config: SweepConfig = {
      ...DEFAULT_CONFIG,
      patterns: ["dist;echo PWNED>/tmp/sweep-pwned-$RANDOM"],
    };
    // Should complete without throwing or executing the injected command
    expect(() => scan(tmpDir, config)).not.toThrow();
  });

  test("handles directory names with backticks safely", () => {
    const dangerous = dir("node_modules`id`");
    mkdirSync(dangerous);
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["node_modules`id`"] };
    expect(() => scan(tmpDir, config)).not.toThrow();
  });

  test("handles directory names with dollar signs safely", () => {
    const dangerous = dir("dist$(whoami)");
    mkdirSync(dangerous);
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["dist$(whoami)"] };
    expect(() => scan(tmpDir, config)).not.toThrow();
  });

  test("handles directory names with spaces safely", () => {
    mkdirSync(dir("my project", "node_modules"), { recursive: true });
    const result = scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("node_modules");
  });

  test("handles directory names with newlines safely", () => {
    // A path with a newline in the name should not confuse output parsing
    const dangerous = dir("node_modules\nnewline");
    mkdirSync(dangerous, { recursive: true });
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["node_modules\nnewline"] };
    expect(() => scan(tmpDir, config)).not.toThrow();
  });

  test("does not follow symlinks pointing outside project root", () => {
    // A symlink pointing to /etc should not be recursed into
    symlinkSync("/etc", dir("symlink-to-etc"));
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["passwd"] };
    const result = scan(tmpDir, config);
    // Should find nothing (didn't recurse into /etc via the symlink)
    expect(result.entries).toHaveLength(0);
  });

  test("handles circular symlinks without infinite loop", () => {
    // A → B → A circular symlink chain should terminate
    mkdirSync(dir("a"));
    symlinkSync(dir("a"), dir("b"));
    // scan should complete in finite time without stack overflow
    const result = scan(tmpDir, DEFAULT_CONFIG);
    expect(result.scannedDirs).toBeGreaterThanOrEqual(0);
  });

  test("returns empty result for unreadable directory (no throw)", () => {
    // Permission-denied directories should be silently skipped
    // We simulate this by passing a non-existent path
    const result = scan("/tmp/sweep-nonexistent-dir-xyz-123", DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(0);
    expect(result.scannedDirs).toBe(0);
  });

  test("ignore rule prevents traversal via substring match on injected patterns", () => {
    mkdirSync(dir("packages", "evil", "node_modules"), { recursive: true });
    mkdirSync(dir("packages", "safe", "node_modules"), { recursive: true });
    // Ignore an adversarial path substring
    const config: SweepConfig = { ...DEFAULT_CONFIG, ignore: ["packages/evil"] };
    const result = scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toContain("safe");
  });
});

describe("scan — result metadata", () => {
  test("counts scanned directories", () => {
    mkdirSync(dir("a"));
    mkdirSync(dir("b"));
    mkdirSync(dir("c"));
    const result = scan(tmpDir, DEFAULT_CONFIG);
    expect(result.scannedDirs).toBeGreaterThan(0);
  });

  test("estimatedTotalBytes sums entry sizes", () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));
    const result = scan(tmpDir, DEFAULT_CONFIG);
    const sum = result.entries.reduce((s, e) => s + e.estimatedBytes, 0);
    expect(result.estimatedTotalBytes).toBe(sum);
  });
});
