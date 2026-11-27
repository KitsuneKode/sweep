import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeMissingRustEngine } from "./doctor.js";
import { resolveEngineBackend } from "./shared.js";

describe("doctor missing rust engine diagnostics", () => {
  test("reports inconclusive Linux libc reason when libc is unknown and no override is set", () => {
    const detail = describeMissingRustEngine("linux", "unknown", undefined);
    expect(detail).toContain("inconclusive");
    expect(detail).toContain("JS");
    expect(detail).toContain("SWEEP_ENGINE_PATH");
  });

  test("keeps plain not found when libc is known, non-Linux, or SWEEP_ENGINE_PATH is explicitly set", () => {
    expect(describeMissingRustEngine("linux", "glibc", undefined)).toBe("not found");
    expect(describeMissingRustEngine("linux", "musl", undefined)).toBe("not found");
    expect(describeMissingRustEngine("darwin", "unknown", undefined)).toBe("not found");
    expect(describeMissingRustEngine("linux", "unknown", "/custom/engine")).toBe("not found");
  });

  test.skipIf(process.platform === "win32")(
    "auto engine mode falls back to JS when the selected native binary fails to start",
    () => {
      const root = mkdtempSync(join(tmpdir(), "sweep-auto-fallback-"));
      const previous = process.env.SWEEP_ENGINE_PATH;
      try {
        const brokenBin = join(root, "sweep-engine");
        // Non-runnable binary (simulates missing loader / incompatible glibc / bad exec).
        writeFileSync(brokenBin, "#!/nonexistent/dynamic-loader\n");
        chmodSync(brokenBin, 0o755);
        process.env.SWEEP_ENGINE_PATH = brokenBin;
        expect(resolveEngineBackend({ engine: "auto" })).toBe("js");

        // Also verify non-zero exit on --version falls back to JS in auto mode.
        const failingBin = join(root, "sweep-engine-fail");
        writeFileSync(failingBin, "#!/bin/sh\nexit 127\n");
        chmodSync(failingBin, 0o755);
        process.env.SWEEP_ENGINE_PATH = failingBin;
        expect(resolveEngineBackend({ engine: "auto" })).toBe("js");
      } finally {
        if (previous === undefined) delete process.env.SWEEP_ENGINE_PATH;
        else process.env.SWEEP_ENGINE_PATH = previous;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
