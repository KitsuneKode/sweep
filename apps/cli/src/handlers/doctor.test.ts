import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliOptions } from "@kitsunekode/sweep-protocol";
import {
  collectDoctorChecks,
  describeMissingRustEngine,
  diagnoseMissingRustEngine,
} from "./doctor.js";
import { resolveEngineBackend } from "./shared.js";
import { registerUiModule, type SweepUiModule } from "./ui.js";

describe("doctor missing rust engine diagnostics", () => {
  test("reports inconclusive Linux libc reasonKind, reason, and detail when libc is unknown and no override is set", () => {
    const diagnosis = diagnoseMissingRustEngine("linux", "unknown", null);
    expect(diagnosis.reasonKind).toBe("libc_unknown");
    expect(diagnosis.reason).toContain("inconclusive");
    expect(diagnosis.reason).toContain("SWEEP_ENGINE_PATH");
    expect(diagnosis.detail).toContain("inconclusive");
    expect(diagnosis.detail).toContain("JS");
    expect(diagnosis.detail).toContain("SWEEP_ENGINE_PATH");
    expect(describeMissingRustEngine("linux", "unknown", null)).toBe(diagnosis.detail);
  });

  test("keeps not_installed diagnosis when libc is known, non-Linux, or SWEEP_ENGINE_PATH is explicitly set", () => {
    for (const diagnosis of [
      diagnoseMissingRustEngine("linux", "glibc", null),
      diagnoseMissingRustEngine("linux", "musl", null),
      diagnoseMissingRustEngine("darwin", "unknown", null),
      diagnoseMissingRustEngine("linux", "unknown", "/custom/engine"),
    ]) {
      expect(diagnosis.detail).toBe("not found");
      expect(diagnosis.reasonKind).toBe("not_installed");
      expect(diagnosis.reason).toBe("Native Rust engine binary was not found.");
    }
    expect(describeMissingRustEngine("linux", "glibc", null)).toBe("not found");
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
        expect(resolveEngineBackend({ engine: "auto" }, { warnOnFallback: false })).toBe("js");

        // Also verify non-zero exit on --version falls back to JS in auto mode.
        const failingBin = join(root, "sweep-engine-fail");
        writeFileSync(failingBin, "#!/bin/sh\nexit 127\n");
        chmodSync(failingBin, 0o755);
        process.env.SWEEP_ENGINE_PATH = failingBin;
        expect(resolveEngineBackend({ engine: "auto" }, { warnOnFallback: false })).toBe("js");
      } finally {
        if (previous === undefined) delete process.env.SWEEP_ENGINE_PATH;
        else process.env.SWEEP_ENGINE_PATH = previous;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

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

  test("reports a full sentence reason when rust_engine is not_installed", async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-doctor-not-installed-"));
    roots.push(root);
    const harness = join(root, "harness.ts");
    const output = join(root, "harness.mjs");
    const target = join(root, "project");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, ".sweeprc"), "{}\n");

    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(
      harness,
      `
import { collectDoctorChecks } from ${JSON.stringify(join(import.meta.dir, "doctor.ts"))};
delete process.env.SWEEP_ENGINE_PATH;
const checks = await collectDoctorChecks(${JSON.stringify(target)}, {
  dryRun: false,
  yes: false,
  forceLarge: false,
  pattern: [],
  ignore: [],
  disabledPattern: [],
  includeDangerous: false,
  select: "default",
  color: false,
  engine: "js",
  json: false,
  quiet: false,
  verbose: false,
});
console.log(JSON.stringify(checks.find((c) => c.name === "rust_engine")));
`,
    );
    const built = await Bun.build({
      entrypoints: [harness],
      target: "bun",
      outdir: root,
      naming: "harness.mjs",
    });
    expect(built.success).toBe(true);

    const baseEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.toUpperCase() === "PATH" || k === "SWEEP_ENGINE_PATH") continue;
      baseEnv[k] = v;
    }

    const proc = Bun.spawn([process.execPath, "--no-install", output], {
      cwd: root,
      env: {
        ...baseEnv,
        PATH: "",
        NODE_PATH: "",
        SWEEP_CONFIG_DIR: join(root, "config"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const rustCheck = JSON.parse(stdout) as {
      ok: boolean;
      detail: string;
      reasonKind?: string;
      reason?: string;
    };
    expect(rustCheck.ok).toBe(false);
    expect(rustCheck.detail).toBe("not found");
    expect(rustCheck.reasonKind).toBe("not_installed");
    expect(rustCheck.reason).toBe("Native Rust engine binary was not found.");
  });
});
