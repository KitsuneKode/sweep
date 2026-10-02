import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "./config.js";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRustEngineAvailable, rustScanBlockedReason } from "./rust-engine.js";

describe("rustScanBlockedReason", () => {
  test("allows default config without streaming or exact sizing", () => {
    expect(rustScanBlockedReason(DEFAULT_CONFIG, DEFAULT_CONFIG, {})).toBeNull();
  });

  test("allows custom patterns and project config", () => {
    const withPattern = { ...DEFAULT_CONFIG, patterns: [...DEFAULT_CONFIG.patterns, "custom"] };
    expect(rustScanBlockedReason(withPattern, DEFAULT_CONFIG, {})).toBeNull();

    const project = { ...DEFAULT_CONFIG, depth: 2 };
    expect(rustScanBlockedReason(project, project, {})).toBeNull();
  });

  test("allows progressive scan callbacks", () => {
    expect(
      rustScanBlockedReason(DEFAULT_CONFIG, DEFAULT_CONFIG, {
        onEntry: () => {},
      }),
    ).toBeNull();
  });

  test("allows exact sizing", () => {
    expect(
      rustScanBlockedReason(DEFAULT_CONFIG, DEFAULT_CONFIG, {
        exact: true,
      }),
    ).toBeNull();
  });
});

test.skipIf(process.platform === "win32")(
  "native probe is bounded and invalidates on binary replacement",
  () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-probe-"));
    const previous = process.env.SWEEP_ENGINE_PATH;
    const binary = join(root, "engine");
    try {
      process.env.SWEEP_ENGINE_PATH = binary;
      writeFileSync(binary, "#!/bin/sh\nexit 0\n");
      chmodSync(binary, 0o700);
      expect(isRustEngineAvailable()).toBe(true);
      writeFileSync(binary, "#!/bin/sh\nexit 3\n");
      expect(isRustEngineAvailable()).toBe(false);
      writeFileSync(binary, "#!/bin/sh\nexec sleep 30\n");
      const start = performance.now();
      expect(isRustEngineAvailable()).toBe(false);
      expect(performance.now() - start).toBeLessThan(3000);
    } finally {
      if (previous === undefined) delete process.env.SWEEP_ENGINE_PATH;
      else process.env.SWEEP_ENGINE_PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
