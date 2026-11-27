#!/usr/bin/env bun
/**
 * Installed-tarball smoke on supported Node.js versions (>=22.12.0) with
 * optional dependencies omitted (no @opentui/core, no native Rust engine).
 *
 * Packs `@kitsunekode/sweep` (or uses `--tarball <tgz>`), installs it with
 * `--omit=optional` into an owned temp prefix, builds a fixture containing a
 * raw non-UTF-8 filename (and raw directory name on Linux), and verifies
 * `scan`, `plan`, `clean --dry-run`, and `doctor --json` under the target Node.
 *
 * Usage:
 *   bun run scripts/smoke-min-node.ts
 *   bun run scripts/smoke-min-node.ts --node /path/to/node --expect-prefix 22.12.
 *   bun run scripts/smoke-min-node.ts --expect-version 22.12.0 --tarball path/to.tgz
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const nodeBin = argValue("--node") ?? process.env.SWEEP_MIN_NODE_BIN ?? "node";
const expectedVersion = argValue("--expect-version");
const expectedPrefix = argValue("--expect-prefix");
const providedTarball = argValue("--tarball");

async function run(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    allowExitCodes?: readonly number[];
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, {
    cwd: options.cwd ?? REPO,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const allowed = options.allowExitCodes ?? [0];
  if (!allowed.includes(code)) {
    throw new Error(
      `${args.join(" ")} failed (exit ${code}):\nstdout: ${stdout.slice(-2000)}\nstderr: ${stderr.slice(-2000)}`,
    );
  }
  return { code, stdout, stderr };
}

function packedTarballPath(output: string, destination: string): string {
  const start = output.search(/^\s*\[/m);
  const files = JSON.parse(start >= 0 ? output.slice(start) : output) as Array<{
    filename: string;
  }>;
  if (files.length !== 1 || !files[0]?.filename) {
    throw new Error("npm pack did not identify a single tarball");
  }
  return join(destination, files[0].filename);
}

const owned = mkdtempSync(join(tmpdir(), "sweep-min-node-smoke-"));
try {
  const nodeMeta = await run([
    nodeBin,
    "-e",
    "console.log(JSON.stringify({ version: process.version, execPath: process.execPath }))",
  ]);
  const { version: versionOut, execPath: resolvedNode } = JSON.parse(nodeMeta.stdout.trim()) as {
    version: string;
    execPath: string;
  };
  if (expectedVersion && versionOut !== `v${expectedVersion}`) {
    throw new Error(`Expected Node v${expectedVersion}, got ${versionOut}`);
  }
  if (expectedPrefix && !versionOut.startsWith(`v${expectedPrefix}`)) {
    throw new Error(`Expected Node v${expectedPrefix}*, got ${versionOut}`);
  }

  const nodeBinDir = dirname(resolvedNode);
  const npmName = process.platform === "win32" ? "npm.cmd" : "npm";
  const pairedNpm = join(nodeBinDir, npmName);
  const npmBin = existsSync(pairedNpm) ? pairedNpm : npmName;
  const installEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: process.env.PATH ? `${nodeBinDir}${delimiter}${process.env.PATH}` : nodeBinDir,
  };
  const npmVersion = (await run([npmBin, "-v"], { env: installEnv })).stdout.trim();

  const installDir = join(owned, "install");
  const configDir = join(owned, "config");
  const tmpSubdir = join(owned, "tmp");
  const fixtureDir = join(owned, "fixture");
  const npmCacheDir = join(owned, "npm-cache");
  for (const dir of [installDir, configDir, tmpSubdir, fixtureDir, npmCacheDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // Pack the CLI tarball (unless pre-packed) and install with all optional
  // dependencies omitted (no @opentui/core, no @kitsunekode/sweep-engine-*).
  const tarball = providedTarball
    ? resolve(providedTarball)
    : packedTarballPath(
        (
          await run(
            ["npm", "pack", "-w", "@kitsunekode/sweep", "--json", "--pack-destination", owned],
            { env: installEnv },
          )
        ).stdout,
        owned,
      );

  writeFileSync(join(installDir, "package.json"), '{"private":true}\n');
  await run(
    [
      npmBin,
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      "--cache",
      npmCacheDir,
      tarball,
    ],
    { cwd: installDir, env: installEnv },
  );

  // npm 9/10 can leave an empty `@opentui/` scope directory behind when pruning
  // omitted optional dependencies; assert no `@opentui/*` or native engine packages exist.
  const openTuiDir = join(installDir, "node_modules", "@opentui");
  const installedOpenTui = existsSync(openTuiDir) ? readdirSync(openTuiDir) : [];
  if (installedOpenTui.length > 0) {
    throw new Error(
      `Expected @opentui packages to be omitted under --omit=optional, found: ${installedOpenTui.join(", ")}`,
    );
  }
  const scopeDir = join(installDir, "node_modules", "@kitsunekode");
  const installedEngines = existsSync(scopeDir)
    ? readdirSync(scopeDir).filter((name) => name.startsWith("sweep-engine-"))
    : [];
  if (installedEngines.length > 0) {
    throw new Error(
      `Expected native engine packages to be omitted under --omit=optional, found: ${installedEngines.join(", ")}`,
    );
  }

  // Build fixture with node_modules and raw non-UTF-8 byte names on Linux.
  const nm = join(fixtureDir, "node_modules");
  mkdirSync(nm, { recursive: true });
  writeFileSync(join(fixtureDir, ".sweeprc"), "{}\n");
  writeFileSync(join(nm, "payload.txt"), "hello-min-node");

  let rawBytesTested = false;
  if (process.platform === "linux") {
    const rawFile = Buffer.from([0x62, 0x61, 0x64, 0xff, 0xfe]);
    const rawDir = Buffer.from([0x64, 0x69, 0x72, 0xff, 0xfe]);
    writeFileSync(Buffer.concat([Buffer.from(`${fixtureDir}/`, "utf8"), rawFile]), "root-raw");
    writeFileSync(Buffer.concat([Buffer.from(`${nm}/`, "utf8"), rawFile]), "nm-raw");
    const nestedRawDir = Buffer.concat([Buffer.from(`${nm}/`, "utf8"), rawDir]);
    mkdirSync(nestedRawDir);
    writeFileSync(Buffer.concat([nestedRawDir, Buffer.from("/"), rawFile]), "nested-raw");
    rawBytesTested = true;
  }

  const entry = join(installDir, "node_modules", "@kitsunekode", "sweep", "dist", "sweep.js");
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: nodeBinDir,
    SWEEP_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: configDir,
    TMPDIR: tmpSubdir,
    SWEEP_ENGINE_PATH: "",
  };

  // 1. scan --engine js --json
  const scanRes = await run([resolvedNode, entry, "scan", fixtureDir, "--engine", "js", "--json"], {
    cwd: fixtureDir,
    env,
  });
  const scanPlan = JSON.parse(scanRes.stdout) as {
    candidates: Array<{ name: string; estimatedBytes: number; identity?: unknown }>;
    targetIdentity?: unknown;
  };
  if (
    scanPlan.candidates.length !== 1 ||
    scanPlan.candidates[0]?.name !== "node_modules" ||
    !scanPlan.targetIdentity ||
    !scanPlan.candidates[0]?.identity
  ) {
    throw new Error(`Unexpected scan output on ${versionOut}: ${scanRes.stdout}`);
  }
  if (rawBytesTested && scanPlan.candidates[0].estimatedBytes < 30) {
    throw new Error(
      `Expected raw-byte files inside node_modules to be sized, got ${scanPlan.candidates[0].estimatedBytes} bytes`,
    );
  }

  // 2. plan --engine js
  const planRes = await run([resolvedNode, entry, "plan", fixtureDir, "--engine", "js"], {
    cwd: fixtureDir,
    env,
  });
  const savedPlan = JSON.parse(planRes.stdout) as { candidates: Array<{ name: string }> };
  if (savedPlan.candidates.length !== 1 || savedPlan.candidates[0]?.name !== "node_modules") {
    throw new Error(`Unexpected plan output on ${versionOut}: ${planRes.stdout}`);
  }

  // 3. clean --dry-run --engine js
  await run([resolvedNode, entry, "clean", fixtureDir, "--dry-run", "--engine", "js"], {
    cwd: fixtureDir,
    env,
  });
  if (!existsSync(nm)) {
    throw new Error("clean --dry-run unexpectedly removed node_modules");
  }

  // 4. doctor --json (exits 5 with missing opentui + rust_engine warnings, dry_scan ok)
  const doctorRes = await run([resolvedNode, entry, "doctor", fixtureDir, "--json"], {
    cwd: fixtureDir,
    env,
    allowExitCodes: [5],
  });
  const doctorReport = JSON.parse(doctorRes.stdout) as {
    hasWarnings: boolean;
    checks: Array<{ name: string; status: string; reasonKind?: string; reason?: string }>;
  };
  const checkByName = new Map(doctorReport.checks.map((c) => [c.name, c]));
  const dryScan = checkByName.get("dry_scan");
  const openTui = checkByName.get("opentui");
  const rustEngine = checkByName.get("rust_engine");
  if (
    !doctorReport.hasWarnings ||
    dryScan?.status !== "ok" ||
    openTui?.status !== "warn" ||
    openTui.reasonKind !== "missing" ||
    rustEngine?.status !== "warn" ||
    rustEngine.reasonKind !== "not_installed"
  ) {
    throw new Error(`Unexpected doctor --json output on ${versionOut}: ${doctorRes.stdout}`);
  }

  console.log(
    JSON.stringify(
      {
        nodeVersion: versionOut,
        npmVersion,
        optionalDepsOmitted: true,
        rawBytesTested,
        estimatedBytes: scanPlan.candidates[0].estimatedBytes,
        doctorExitCode: doctorRes.code,
        commands: [
          "scan --engine js --json",
          "plan --engine js",
          "clean --dry-run --engine js",
          "doctor --json",
        ],
        ok: true,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(owned, { recursive: true, force: true });
}
