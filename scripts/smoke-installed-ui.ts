#!/usr/bin/env bun
/**
 * Installed-artifact TUI smoke (Codex A01):
 *
 * 1. Packs `@kitsunekode/sweep` from the workspace (`npm pack -w`).
 * 2. Seeds an isolated global Bun prefix (`BUN_INSTALL_GLOBAL_DIR` /
 *    `BUN_INSTALL_BIN`) with `@opentui/core@0.1.97`.
 * 3. Globally installs the packed `@kitsunekode/sweep` tarball into that same
 *    prefix, runs `sweep ui <fixture> --dry-run` in a private tmux PTY, waits
 *    for the first settled frame, sends `q`, and asserts exit code 1.
 * 4. Forces resolution of the seeded `@opentui/core@0.1.97` (simulating the
 *    0.5.2 shared-global mismatch) and asserts `sweep ui` fails with the clear
 *    compatibility diagnostic (exit 2, no SyntaxError) and `sweep doctor --json`
 *    reports the same mismatch.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const TMUX = Bun.which("tmux");
if (!TMUX) {
  console.error("smoke-installed-ui: tmux is required");
  process.exit(1);
}

const owned = mkdtempSync(join(tmpdir(), "sweep-installed-ui-smoke-"));
// Unix domain sockets are limited to 108 bytes on Linux, and TMPDIR can be deep.
const tmuxSock = join(
  "/tmp",
  `swp-ui-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`,
);

async function run(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined>; allowFailure?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(args, {
    cwd: options.cwd ?? REPO,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (!options.allowFailure && code !== 0) {
    throw new Error(
      `${args.join(" ")} failed (${code}):\nstdout: ${stdout.slice(-2000)}\nstderr: ${stderr.slice(-2000)}`,
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

async function waitForFile(filePath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8").trim();
      if (content.length > 0) return content;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function runTmux(
  args: string[],
  options: { allowFailure?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<string> {
  const res = await run([TMUX!, "-S", tmuxSock, "-f", "/dev/null", ...args], options);
  return res.stdout;
}

try {
  const globalDir = join(owned, "bun-global");
  const binDir = join(owned, "bun-bin");
  const configDir = join(owned, "config");
  const tmpSubdir = join(owned, "tmp");
  const fixtureDir = join(owned, "fixture");
  for (const dir of [globalDir, binDir, configDir, tmpSubdir, fixtureDir]) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(join(fixtureDir, ".sweeprc"), "{}\n");
  for (const project of ["alpha", "bravo"]) {
    const nm = join(fixtureDir, project, "node_modules");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "payload.txt"), `${project}-`.repeat(2048));
  }

  const isolatedEnv: Record<string, string | undefined> = {
    ...process.env,
    BUN_INSTALL_GLOBAL_DIR: globalDir,
    BUN_INSTALL_BIN: binDir,
    SWEEP_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: configDir,
    TMPDIR: tmpSubdir,
    SWEEP_ENGINE_PATH: "",
    SWEEP_REDUCED_MOTION: "1",
    TERM: "xterm-256color",
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };

  // 1. Pack the CLI from this checkout.
  const packOut = await run([
    "npm",
    "pack",
    "-w",
    "@kitsunekode/sweep",
    "--json",
    "--pack-destination",
    owned,
  ]);
  const cliTarball = packedTarballPath(packOut.stdout, owned);

  // 2. Seed global Bun prefix with @opentui/core@0.1.97 and snapshot it for the
  //    forced-mismatch simulation below.
  await run(["bun", "add", "-g", "--ignore-scripts", "@opentui/core@0.1.97"], {
    cwd: owned,
    env: isolatedEnv,
  });
  const seededCoreDir = join(globalDir, "node_modules", "@opentui", "core");
  if (!existsSync(join(seededCoreDir, "package.json"))) {
    throw new Error("Failed to seed @opentui/core@0.1.97 into isolated global dir");
  }
  const seededCoreSnapshot = join(owned, "seeded-core-0.1.97");
  cpSync(seededCoreDir, seededCoreSnapshot, { recursive: true, dereference: true });

  // 3. Globally install our packed tarball into the seeded prefix.
  await run(["bun", "add", "-g", "--ignore-scripts", cliTarball], {
    cwd: owned,
    env: isolatedEnv,
  });
  const installedBin = join(binDir, "sweep");
  if (!existsSync(installedBin)) {
    throw new Error(`Expected installed binary at ${installedBin}`);
  }

  // 4. Launch installed `sweep ui <fixture> --dry-run` in a private tmux PTY,
  //    wait for the first settled frame, send `q`, and assert exit code 1.
  const exitFile = join(owned, "ui-exit.txt");
  await runTmux(
    [
      "new-session",
      "-d",
      "-s",
      "ok",
      "-x",
      "100",
      "-y",
      "28",
      `sh -c '"$1" ui "$2" --dry-run; printf "%s" "$?" > "$3"' _ ${JSON.stringify(installedBin)} ${JSON.stringify(fixtureDir)} ${JSON.stringify(exitFile)}`,
    ],
    { env: isolatedEnv },
  );

  let settledFrame = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(exitFile)) {
      const code = readFileSync(exitFile, "utf8").trim();
      const captured = await runTmux(["capture-pane", "-p", "-t", "ok"], { allowFailure: true });
      throw new Error(`Installed sweep ui exited early (${code}). Screen:\n${captured}`);
    }
    const captured = await runTmux(["capture-pane", "-p", "-t", "ok"], { allowFailure: true });
    if (
      /you can reclaim/i.test(captured) &&
      (captured.includes("alpha") || captured.includes("bravo")) &&
      !captured.includes("Looking for build output")
    ) {
      settledFrame = captured;
      break;
    }
    await Bun.sleep(100);
  }
  if (!settledFrame) {
    const captured = await runTmux(["capture-pane", "-p", "-t", "ok"], { allowFailure: true });
    throw new Error(`Timed out waiting for first settled frame. Last capture:\n${captured}`);
  }

  await runTmux(["send-keys", "-t", "ok", "q"]);
  const uiExitCode = Number(await waitForFile(exitFile, 8_000));
  if (uiExitCode !== 1) {
    throw new Error(`Expected documented abort exit code 1 after q, got ${uiExitCode}`);
  }

  // 5. Simulate published-0.5.2-style resolution of @opentui/core@0.1.97 and
  //    verify clear mismatch diagnostics (no raw SyntaxError).
  const mismatchRoot = join(owned, "mismatch-global");
  const installedSweepDir = join(globalDir, "node_modules", "@kitsunekode", "sweep");
  const mismatchSweepDir = join(mismatchRoot, "node_modules", "@kitsunekode", "sweep");
  const mismatchCoreDir = join(mismatchRoot, "node_modules", "@opentui", "core");
  mkdirSync(join(mismatchRoot, "node_modules", "@kitsunekode"), { recursive: true });
  mkdirSync(join(mismatchRoot, "node_modules", "@opentui"), { recursive: true });
  cpSync(installedSweepDir, mismatchSweepDir, { recursive: true, dereference: true });
  rmSync(join(mismatchSweepDir, "node_modules", "@opentui"), { recursive: true, force: true });
  cpSync(seededCoreSnapshot, mismatchCoreDir, { recursive: true });

  const mismatchSweepJs = join(mismatchSweepDir, "dist", "sweep.js");
  const mismatchExitFile = join(owned, "mismatch-exit.txt");
  await runTmux(
    [
      "new-session",
      "-d",
      "-s",
      "mismatch",
      "-x",
      "120",
      "-y",
      "30",
      `sh -c 'bun "$1" ui "$2" --dry-run; printf "%s" "$?" > "$3"; sleep 10' _ ${JSON.stringify(mismatchSweepJs)} ${JSON.stringify(fixtureDir)} ${JSON.stringify(mismatchExitFile)}`,
    ],
    { env: isolatedEnv },
  );

  const mismatchExit = Number(await waitForFile(mismatchExitFile, 10_000));
  const mismatchOut = await runTmux(["capture-pane", "-p", "-S", "-100", "-t", "mismatch"]);
  if (mismatchExit !== 2) {
    throw new Error(
      `Expected guardrail exit code 2 on incompatible @opentui/core@0.1.97, got ${mismatchExit}:\n${mismatchOut}`,
    );
  }
  if (/SyntaxError|Export named 'ImageRenderable' not found/i.test(mismatchOut)) {
    throw new Error(`Expected clear compatibility error, got raw SyntaxError:\n${mismatchOut}`);
  }
  for (const expected of ["0.1.97", "@opentui/core", "bunx @kitsunekode/sweep ui", "standalone"]) {
    if (!mismatchOut.includes(expected)) {
      throw new Error(`Mismatch message missing ${JSON.stringify(expected)}:\n${mismatchOut}`);
    }
  }

  const doctorRes = await run(["bun", mismatchSweepJs, "doctor", fixtureDir, "--json"], {
    cwd: owned,
    env: isolatedEnv,
    allowFailure: true,
  });
  if (doctorRes.code !== 5) {
    throw new Error(
      `Expected doctor exit 5 on incompatible @opentui/core, got ${doctorRes.code}:\n${doctorRes.stdout}\n${doctorRes.stderr}`,
    );
  }
  const doctorJson = JSON.parse(doctorRes.stdout) as {
    checks: Array<{
      name: string;
      status: string;
      detail: string;
      reasonKind?: string;
      reason?: string;
    }>;
  };
  const openTuiCheck = doctorJson.checks.find((c) => c.name === "opentui");
  if (
    !openTuiCheck ||
    openTuiCheck.status !== "warn" ||
    !openTuiCheck.detail.includes("0.1.97") ||
    openTuiCheck.reasonKind !== "version_mismatch" ||
    !openTuiCheck.reason?.includes("0.1.97")
  ) {
    throw new Error(`Unexpected doctor opentui check: ${JSON.stringify(openTuiCheck)}`);
  }

  console.log(
    JSON.stringify(
      {
        installedUiExitCode: uiExitCode,
        mismatchExitCode: mismatchExit,
        doctorOpenTuiStatus: openTuiCheck.status,
        doctorOpenTuiReasonKind: openTuiCheck.reasonKind,
        doctorOpenTuiReason: openTuiCheck.reason,
        ok: true,
      },
      null,
      2,
    ),
  );
} finally {
  await runTmux(["kill-server"], { allowFailure: true });
  rmSync(tmuxSock, { force: true });
  rmSync(owned, { recursive: true, force: true });
}
