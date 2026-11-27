import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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

describe("collectDoctorChecks config permission parity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sweep-doctor-test-"));
    roots.push(tmpDir);
    process.env.SWEEP_CONFIG_DIR = join(tmpDir, "sweep-config");
  });

  test("validates a regular .sweeprc and rejects an invalid one consistently", async () => {
    const project = join(tmpDir, "basic-project");
    mkdirSync(project, { recursive: true });
    const configPath = join(project, ".sweeprc");
    writeFileSync(configPath, JSON.stringify({ patterns: ["custom-cache"] }));

    const okChecks = await collectDoctorChecks(project, baseCliOpts({ engine: "js" }));
    expect(okChecks.find((c) => c.name === "config")?.ok).toBe(true);

    writeFileSync(configPath, "{ invalid json");
    const badChecks = await collectDoctorChecks(project, baseCliOpts({ engine: "js" }));
    expect(badChecks.find((c) => c.name === "config")?.ok).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "allows 0664 .sweeprc owned by primary group and warns on other-group or world-writable with fix guidance",
    async () => {
      const project = join(tmpDir, "project");
      mkdirSync(project, { recursive: true });
      const configPath = join(project, ".sweeprc");
      writeFileSync(configPath, JSON.stringify({ patterns: ["custom-cache"] }));

      // Own primary group + g+w is allowed.
      chmodSync(configPath, 0o664);
      const allowedChecks = await collectDoctorChecks(project, baseCliOpts({ engine: "js" }));
      const allowedConfig = allowedChecks.find((c) => c.name === "config");
      expect(allowedConfig?.ok).toBe(true);

      // Other-group writable is refused with chmod g-w / --config explicitly guidance.
      const gidSpy = spyOn(process, "getgid").mockReturnValue(process.getgid!() + 1);
      try {
        const otherGroupChecks = await collectDoctorChecks(project, baseCliOpts({ engine: "js" }));
        const otherGroupConfig = otherGroupChecks.find((c) => c.name === "config");
        expect(otherGroupConfig?.ok).toBe(false);
        expect(otherGroupConfig?.detail).toContain("chmod g-w");
        expect(otherGroupConfig?.detail).toContain("--config explicitly");

        // Passing --config explicitly validates and allows the same file.
        const explicitChecks = await collectDoctorChecks(
          project,
          baseCliOpts({ engine: "js", config: configPath }),
        );
        const explicitConfig = explicitChecks.find((c) => c.name === "config");
        expect(explicitConfig?.ok).toBe(true);
      } finally {
        gidSpy.mockRestore();
      }

      // World-writable is always refused even when gid matches.
      chmodSync(configPath, 0o666);
      const worldChecks = await collectDoctorChecks(project, baseCliOpts({ engine: "js" }));
      const worldConfig = worldChecks.find((c) => c.name === "config");
      expect(worldConfig?.ok).toBe(false);
      expect(worldConfig?.detail).toMatch(/chmod/);
      expect(worldConfig?.detail).toContain("--config explicitly");
    },
  );
});
