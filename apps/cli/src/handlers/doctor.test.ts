import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { collectDoctorChecks } from "./doctor.js";
import { registerUiModule, type SweepUiModule } from "./ui.js";

function baseCliOpts(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    dryRun: false,
    yes: false,
    forceLarge: false,
    pattern: [],
    ignore: [],
    disabledPattern: [],
    includeDangerous: false,
    select: "default",
    color: false,
    engine: "auto",
    json: false,
    quiet: false,
    verbose: false,
    ...overrides,
  };
}

const roots: string[] = [];
const previousEngine = process.env.SWEEP_ENGINE_PATH;
const previousConfig = process.env.SWEEP_CONFIG_DIR;

afterEach(() => {
  registerUiModule(null as unknown as SweepUiModule);
  if (previousEngine === undefined) delete process.env.SWEEP_ENGINE_PATH;
  else process.env.SWEEP_ENGINE_PATH = previousEngine;
  if (previousConfig === undefined) delete process.env.SWEEP_CONFIG_DIR;
  else process.env.SWEEP_CONFIG_DIR = previousConfig;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("collectDoctorChecks", () => {
  test("does not warn about opentui when an embedded standalone UI module is registered", async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-doctor-standalone-"));
    roots.push(root);
    process.env.SWEEP_CONFIG_DIR = join(root, "config");
    const target = join(root, "project");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, ".sweeprc"), "{}\n");

    registerUiModule({
      runSweepUiStreaming: async () => ({ type: "abort" }),
    });

    const checks = await collectDoctorChecks(target, baseCliOpts({ engine: "js" }));
    const openTui = checks.find((check) => check.name === "opentui");
    expect(openTui).toBeDefined();
    expect(openTui?.ok).toBe(true);
    expect(openTui?.detail).toContain("embedded");
    expect(openTui?.reasonKind).toBeUndefined();
    expect(openTui?.reason).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")(
    "reports rust engine probe failure reasonKind and human reason sentence",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "sweep-doctor-rust-reason-"));
      roots.push(root);
      process.env.SWEEP_CONFIG_DIR = join(root, "config");
      const target = join(root, "project");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, ".sweeprc"), "{}\n");

      const fakeEngine = join(root, "broken-engine");
      writeFileSync(
        fakeEngine,
        "#!/bin/sh\necho \"/lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.39' not found\" >&2\nexit 127\n",
      );
      chmodSync(fakeEngine, 0o700);
      process.env.SWEEP_ENGINE_PATH = fakeEngine;

      const checks = await collectDoctorChecks(target, baseCliOpts({ engine: "auto" }));
      const rustCheck = checks.find((check) => check.name === "rust_engine");
      expect(rustCheck).toBeDefined();
      expect(rustCheck?.ok).toBe(false);
      expect(rustCheck?.detail).toContain("127");
      expect(rustCheck?.detail).toContain("GLIBC_2.39");
      expect(rustCheck?.reasonKind).toBe("probe_failed");
      expect(rustCheck?.reason).toContain("GLIBC_2.39");

      const safetyCheck = checks.find((check) => check.name === "rust_apply_safety");
      expect(safetyCheck?.ok).toBe(false);
      expect(safetyCheck?.reasonKind).toBe("engine_unavailable");
      expect(safetyCheck?.reason).toBeTruthy();

      // Every warning check carries both a stable reasonKind and human reason.
      for (const check of checks) {
        if (!check.ok) {
          expect(check.reasonKind).toBeTruthy();
          expect(check.reason).toBeTruthy();
        }
      }
    },
  );
});
