import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_PATTERNS,
  loadConfig,
  buildRescanConfig,
  ConfigParseError,
  validateProjectConfigFile,
  writeInitSweeprc,
  writeProjectSweeprc,
  isIgnoredEntry,
} from "./config.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sweep-config-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const dir = (...parts: string[]) => join(tmpDir, ...parts);

function writeConfig(dirPath: string, config: object): void {
  writeFileSync(join(dirPath, ".sweeprc"), JSON.stringify(config));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("loadConfig: defaults", () => {
  test("returns built-in defaults when no config files exist", () => {
    const config = loadConfig(dir("nonexistent-project"));
    expect(config.patterns).toEqual(DEFAULT_CONFIG.patterns);
    expect(config.maxSizeGB).toBe(10);
    expect(config.depth).toBe(-1);
    expect(config.ignore).toEqual(DEFAULT_CONFIG.ignore);
  });

  test("default patterns are the unambiguous machine-created names only", () => {
    const config = loadConfig(dir("nonexistent"));
    expect(config.patterns).toContain("node_modules");
    expect(config.patterns).toContain(".next");
    expect(config.patterns).toContain("target");
    // Generic names a human could author are opt-in, never shipped on:
    // enabling them is the user's call, not ours.
    expect(config.patterns).not.toContain("dist");
    expect(config.patterns).not.toContain("build");
    expect(config.patterns).not.toContain("out");
    expect(config.patterns).not.toContain("coverage");
  });

  test(".cache is NOT in default patterns", () => {
    const config = loadConfig(dir("nonexistent"));
    expect(config.patterns).not.toContain(".cache");
  });
});

describe("loadConfig: project config (.sweeprc)", () => {
  test("finds .sweeprc in the target directory", () => {
    mkdirSync(dir("project"), { recursive: true });
    writeConfig(dir("project"), { maxSizeGB: 5 });
    const config = loadConfig(dir("project"));
    expect(config.maxSizeGB).toBe(5);
  });

  test("walks up to find .sweeprc in parent", () => {
    mkdirSync(dir("project", "packages", "web"), { recursive: true });
    writeConfig(dir("project"), { maxSizeGB: 3 });
    // Run from the nested package - should find config in project root
    const config = loadConfig(dir("project", "packages", "web"));
    expect(config.maxSizeGB).toBe(3);
  });

  test("uses closest .sweeprc (CWD wins over parent)", () => {
    mkdirSync(dir("project", "sub"), { recursive: true });
    writeConfig(dir("project"), { maxSizeGB: 5 });
    writeConfig(dir("project", "sub"), { maxSizeGB: 2 });
    const config = loadConfig(dir("project", "sub"));
    expect(config.maxSizeGB).toBe(2);
  });

  test("merges project patterns WITH defaults (not replacing)", () => {
    mkdirSync(dir("project"), { recursive: true });
    writeConfig(dir("project"), { patterns: ["custom-output"] });
    const config = loadConfig(dir("project"));
    // Should have both default patterns and the new one
    expect(config.patterns).toContain("node_modules");
    expect(config.patterns).toContain("custom-output");
  });

  test("deduplicates merged patterns", () => {
    mkdirSync(dir("project"), { recursive: true });
    // node_modules is already in defaults - adding it again should not duplicate
    writeConfig(dir("project"), { patterns: ["node_modules", "custom"] });
    const config = loadConfig(dir("project"));
    const nodeModulesCount = config.patterns.filter((p) => p === "node_modules").length;
    expect(nodeModulesCount).toBe(1);
  });

  test("throws on malformed JSON config", () => {
    mkdirSync(dir("bad-project"), { recursive: true });
    writeFileSync(dir("bad-project", ".sweeprc"), "{ invalid json ]");
    expect(() => loadConfig(dir("bad-project"))).toThrow(ConfigParseError);
  });
});

describe("validateProjectConfigFile", () => {
  test("accepts a valid project config", () => {
    mkdirSync(dir("project"), { recursive: true });
    writeConfig(dir("project"), { patterns: ["custom-output"], maxSizeGB: 5 });
    const result = validateProjectConfigFile(dir("project", ".sweeprc"), dir("project"));
    expect(result.ok).toBe(true);
  });

  test("rejects unknown fields", () => {
    mkdirSync(dir("project"), { recursive: true });
    writeFileSync(dir("project", ".sweeprc"), JSON.stringify({ extraField: true }));
    const result = validateProjectConfigFile(dir("project", ".sweeprc"), dir("project"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("unknown field");
    }
  });

  test("rejects invalid field types", () => {
    mkdirSync(dir("project"), { recursive: true });
    writeConfig(dir("project"), { maxSizeGB: "ten" });
    const result = validateProjectConfigFile(dir("project", ".sweeprc"), dir("project"));
    expect(result.ok).toBe(false);
  });
});

describe("writeInitSweeprc", () => {
  test("creates .sweeprc when missing", () => {
    mkdirSync(dir("project"), { recursive: true });
    const configPath = dir("project", ".sweeprc");
    expect(writeInitSweeprc(configPath)).toBe("created");
    expect(loadConfig(dir("project")).patterns).toContain(".custom-output");
  });

  test("refuses to overwrite without force", () => {
    mkdirSync(dir("project"), { recursive: true });
    writeConfig(dir("project"), { maxSizeGB: 1 });
    const configPath = dir("project", ".sweeprc");
    expect(writeInitSweeprc(configPath)).toBe("exists");
    expect(loadConfig(dir("project")).maxSizeGB).toBe(1);
  });

  test("refuses to write through a symlinked .sweeprc - even with force", () => {
    // A hostile checkout can ship .sweeprc -> ~/.ssh/config; writeFileSync
    // would follow the link and truncate the target. Refuse instead.
    if (process.platform === "win32") return; // symlink perms vary
    mkdirSync(dir("project"), { recursive: true });
    writeFileSync(dir("outside.txt"), "keep me");
    symlinkSync(dir("outside.txt"), dir("project", ".sweeprc"));

    expect(() => writeInitSweeprc(dir("project", ".sweeprc"), true)).toThrow(ConfigParseError);
    expect(readFileSync(dir("outside.txt"), "utf-8")).toBe("keep me");
  });
});

describe("writeProjectSweeprc", () => {
  const delta = { patterns: ["dist", "*.bak"], disabledPatterns: ["coverage"] };

  test("writes a delta-only .sweeprc that loads back", () => {
    mkdirSync(dir("project"), { recursive: true });
    const configPath = dir("project", ".sweeprc");
    expect(writeProjectSweeprc(configPath, delta)).toBe("created");

    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.patterns).toEqual(["*.bak", "dist"]); // sorted, deduped
    expect(written.disabledPatterns).toEqual(["coverage"]);
    // Delta-only: scalar fields are not the pane's to write.
    expect(written.maxSizeGB).toBeUndefined();
    expect(written.depth).toBeUndefined();
    expect(written.ignore).toBeUndefined();

    // And it round-trips through the real loader.
    const loaded = loadConfig(dir("project"));
    expect(loaded.patterns).toContain("dist");
    expect(loaded.patterns).toContain("*.bak");
    expect(loaded.patterns).not.toContain("coverage");
  });

  test("refuses to clobber an existing file without force; force updates", () => {
    mkdirSync(dir("project"), { recursive: true });
    writeConfig(dir("project"), { maxSizeGB: 3 });
    const configPath = dir("project", ".sweeprc");

    expect(writeProjectSweeprc(configPath, delta)).toBe("exists");
    // Untouched - the pane's w must never silently overwrite a hand config.
    expect(loadConfig(dir("project")).maxSizeGB).toBe(3);
    expect(JSON.parse(readFileSync(configPath, "utf-8")).patterns).toBeUndefined();

    expect(writeProjectSweeprc(configPath, delta, true)).toBe("updated");
    expect(JSON.parse(readFileSync(configPath, "utf-8")).patterns).toContain("dist");
  });

  test("a forced update preserves fields the pattern pane does not own", () => {
    // shift-W overwrites - but an existing hand-authored config carries
    // guardrails (maxSizeGB, depth, ignore) that are not the pane's to drop.
    mkdirSync(dir("project"), { recursive: true });
    writeConfig(dir("project"), { maxSizeGB: 3, depth: 4, ignore: ["keep-me"] });
    const configPath = dir("project", ".sweeprc");

    expect(writeProjectSweeprc(configPath, delta, true)).toBe("updated");
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.patterns).toContain("dist");
    expect(written.maxSizeGB).toBe(3);
    expect(written.depth).toBe(4);
    expect(written.ignore).toEqual(["keep-me"]);
    expect(loadConfig(dir("project")).maxSizeGB).toBe(3);
  });

  test("a forced update refuses when the existing file is not parseable", () => {
    // Better to fail loud than to silently discard a config the user wrote.
    mkdirSync(dir("project"), { recursive: true });
    const configPath = dir("project", ".sweeprc");
    writeFileSync(configPath, "{ not json");

    expect(() => writeProjectSweeprc(configPath, delta, true)).toThrow(ConfigParseError);
    expect(readFileSync(configPath, "utf-8")).toBe("{ not json");
  });

  test("refuses to write through a symlinked .sweeprc", () => {
    if (process.platform === "win32") return; // symlink perms vary
    mkdirSync(dir("project"), { recursive: true });
    writeFileSync(dir("outside.txt"), "keep me");
    symlinkSync(dir("outside.txt"), dir("project", ".sweeprc"));

    expect(() => writeProjectSweeprc(dir("project", ".sweeprc"), delta, true)).toThrow(
      ConfigParseError,
    );
    expect(readFileSync(dir("outside.txt"), "utf-8")).toBe("keep me");
  });

  test("omits empty keys so an all-defaults pane writes a minimal file", () => {
    mkdirSync(dir("project"), { recursive: true });
    const configPath = dir("project", ".sweeprc");
    expect(writeProjectSweeprc(configPath, { patterns: [], disabledPatterns: [] })).toBe("created");
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({});
  });
});

describe("isIgnoredEntry: globs", () => {
  test("matches basename globs like *.cache", () => {
    mkdirSync(dir("project", "foo.cache"), { recursive: true });
    expect(
      isIgnoredEntry(dir("project"), dir("project", "foo.cache"), "foo.cache", ["*.cache"]),
    ).toBe(true);
    expect(
      isIgnoredEntry(dir("project"), dir("project", "node_modules"), "node_modules", ["*.cache"]),
    ).toBe(false);
  });

  test("still matches exact names and path prefixes", () => {
    expect(isIgnoredEntry(dir("project"), dir("project", "dist"), "dist", ["dist"])).toBe(true);
    expect(
      isIgnoredEntry(
        dir("project"),
        dir("project", "packages", "vendor", "node_modules"),
        "node_modules",
        ["packages/vendor"],
      ),
    ).toBe(true);
  });
});

describe("loadConfig: explicit --config path", () => {
  test("uses explicit config file, skipping walk-up", () => {
    mkdirSync(dir("configs"), { recursive: true });
    mkdirSync(dir("project"), { recursive: true });
    const configPath = dir("configs", "my-sweep.json");
    writeFileSync(configPath, JSON.stringify({ maxSizeGB: 7 }));
    // Even if a .sweeprc exists in project, explicit path takes precedence
    writeConfig(dir("project"), { maxSizeGB: 99 });
    const config = loadConfig(dir("project"), configPath);
    expect(config.maxSizeGB).toBe(7);
  });
});

describe("loadConfig: CLI overrides", () => {
  test("CLI maxSizeGB overrides project config", () => {
    mkdirSync(dir("project"), { recursive: true });
    writeConfig(dir("project"), { maxSizeGB: 5 });
    const config = loadConfig(dir("project"), undefined, { maxSizeGB: 2 });
    expect(config.maxSizeGB).toBe(2);
  });

  test("CLI patterns are merged with defaults + project", () => {
    mkdirSync(dir("project"), { recursive: true });
    writeConfig(dir("project"), { patterns: ["project-output"] });
    const config = loadConfig(dir("project"), undefined, { patterns: ["cli-pattern"] });
    expect(config.patterns).toContain("node_modules"); // default
    expect(config.patterns).toContain("project-output"); // project
    expect(config.patterns).toContain("cli-pattern"); // CLI
  });

  test("CLI depth overrides all layers", () => {
    mkdirSync(dir("project"), { recursive: true });
    writeConfig(dir("project"), { depth: 5 });
    const config = loadConfig(dir("project"), undefined, { depth: 2 });
    expect(config.depth).toBe(2);
  });

  test("disabledPatterns removes defaults from merged patterns", () => {
    mkdirSync(dir("project"), { recursive: true });
    writeConfig(dir("project"), { disabledPatterns: ["dist", "build"] });
    const config = loadConfig(dir("project"));
    expect(config.patterns).toContain("node_modules");
    expect(config.patterns).not.toContain("dist");
    expect(config.patterns).not.toContain("build");
    expect(config.disabledPatterns).toEqual(["dist", "build"]);
  });

  test("CLI disabledPatterns merge with project disabledPatterns", () => {
    mkdirSync(dir("project"), { recursive: true });
    writeConfig(dir("project"), { disabledPatterns: ["node_modules"] });
    const config = loadConfig(dir("project"), undefined, { disabledPatterns: ["target"] });
    expect(config.patterns).not.toContain("node_modules");
    expect(config.patterns).not.toContain("target");
    expect(config.patterns).toContain(".next");
  });
});

describe("buildRescanConfig", () => {
  test("uses UI disabled patterns authoritatively without re-merging project disabledPatterns", () => {
    const current = loadConfig(dir("nonexistent"), undefined, {
      patterns: [".cache"],
      disabledPatterns: ["dist"],
      ignore: ["vendor"],
      depth: 3,
      maxSizeGB: 4,
    });

    const next = buildRescanConfig(current, {
      disabledPatterns: [],
      extraPatterns: [".cache", "dist"],
    });

    // A project-disabled default re-enables through the UI, and an opt-in
    // catalog name like dist survives only as an explicit extra.
    expect(next.patterns).toContain("node_modules");
    expect(next.patterns).toContain(".cache");
    expect(next.patterns).toContain("dist");
    expect(next.disabledPatterns).toBeUndefined();
    expect(next.ignore).toEqual([...DEFAULT_CONFIG.ignore, "vendor"]);
    expect(next.depth).toBe(3);
    expect(next.maxSizeGB).toBe(4);
  });

  test("rebuilds active catalog patterns from disabled + extra sets", () => {
    const current = loadConfig(dir("nonexistent"));

    const next = buildRescanConfig(current, {
      disabledPatterns: ["dist", "build"],
      extraPatterns: ["custom-artifact"],
    });

    expect(next.patterns).toContain("node_modules");
    expect(next.patterns).toContain("custom-artifact");
    expect(next.patterns).not.toContain("dist");
    expect(next.patterns).not.toContain("build");
    expect(next.disabledPatterns).toEqual(["dist", "build"]);
  });
});

describe("DEFAULT_PATTERNS sanity checks", () => {
  test("does not include .cache", () => {
    expect(DEFAULT_PATTERNS).not.toContain(".cache");
  });

  test("does not include /", () => {
    expect(DEFAULT_PATTERNS.every((p) => !p.startsWith("/"))).toBe(true);
  });

  test("does not include ..", () => {
    expect(DEFAULT_PATTERNS.every((p) => !p.includes(".."))).toBe(true);
  });
});

describe("config hardening", () => {
  test("rejects a non-regular .sweeprc (FIFO would hang readFileSync)", () => {
    // A directory is the portable stand-in for "not a regular file".
    mkdirSync(dir("fifo-project", ".sweeprc"), { recursive: true });
    expect(() => loadConfig(dir("fifo-project"))).toThrow(ConfigParseError);
    expect(() => loadConfig(dir("fifo-project"))).toThrow(/not a regular file/);
  });

  test("rejects an oversized .sweeprc", () => {
    mkdirSync(dir("big-project"), { recursive: true });
    writeFileSync(dir("big-project", ".sweeprc"), " ".repeat(1024 * 1024 + 1));
    expect(() => loadConfig(dir("big-project"))).toThrow(/exceeds 1024 KB/);
  });

  test("rejects a pattern longer than the bound", () => {
    mkdirSync(dir("long-pattern"), { recursive: true });
    writeConfig(dir("long-pattern"), { patterns: ["x".repeat(300)] });
    expect(() => loadConfig(dir("long-pattern"))).toThrow(/exceeds 128 characters/);
  });

  test("rejects a merged pattern list past the bound", () => {
    mkdirSync(dir("many-patterns"), { recursive: true });
    writeConfig(dir("many-patterns"), {
      ignore: Array.from({ length: 513 }, (_, i) => `dir-${i}`),
    });
    expect(() => loadConfig(dir("many-patterns"))).toThrow(/max 512/);
  });
});
