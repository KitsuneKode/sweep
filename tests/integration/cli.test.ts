import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ScanEvent, ScanPlan, StatusSummary } from "@kitsunekode/sweep-protocol";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SWEEP = join(REPO_ROOT, "apps/cli/dist/sweep.js");
const LOCAL_RUST_ENGINE = join(
  REPO_ROOT,
  "target",
  "debug",
  process.platform === "win32" ? "sweep-engine.exe" : "sweep-engine",
);

const NATIVE_CLI_AVAILABLE = existsSync(LOCAL_RUST_ENGINE);
if (process.env.SWEEP_REQUIRE_RUST_TESTS === "1" && !NATIVE_CLI_AVAILABLE)
  throw new Error("Native CLI coverage is required, but the Rust test engine is missing");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sweep-cli-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const dir = (...parts: string[]) => join(tmpDir, ...parts);

function runCli(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const withEngine = args.includes("--engine") ? args : ["--engine", "js", ...args];
  const proc = Bun.spawnSync({
    cmd: ["bun", SWEEP, ...withEngine],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    // Isolate user state - applies write to the real history.jsonl otherwise.
    env: {
      ...process.env,
      SWEEP_CONFIG_DIR: dir("test-config"),
      ...env,
    },
  });

  return {
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
    exitCode: proc.exitCode,
  };
}

describe("CLI scan/apply", () => {
  test("Bun keeps larger NDJSON intact when its consumer starts late", async () => {
    const count = 400;
    for (let i = 0; i < count; i++) writeFileSync(dir(`${i}-${"x".repeat(100)}.tmp`), "x");
    const proc = Bun.spawn({
      cmd: ["bun", SWEEP, "scan", tmpDir, "--json-stream", "--engine", "js", "--pattern", "*.tmp"],
      cwd: REPO_ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SWEEP_CONFIG_DIR: dir("test-config") },
    });
    const stderr = new Response(proc.stderr).text();
    try {
      // More than stdout's high-water mark accumulates before any consumer reads.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const reader = proc.stdout.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const events = Buffer.concat(chunks)
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as ScanEvent);
      expect(await proc.exited).toBe(0);
      expect(events.filter((e) => e.type === "candidate_found")).toHaveLength(count);
      expect(events.filter((e) => e.type === "candidate_updated")).toHaveLength(count);
      const completed = events.at(-1);
      expect(completed?.type).toBe("scan_completed");
      if (completed?.type === "scan_completed")
        expect(completed.summary.candidateCount).toBe(count);
      expect(await stderr).not.toContain("MaxListenersExceeded");
    } finally {
      if (proc.exitCode === null) proc.kill();
    }
  }, 15_000);
  test("JSON clean and apply previews flush their full plan before exiting", async () => {
    const count = 200;
    for (let i = 0; i < count; i++) writeFileSync(dir(`${i}-${"x".repeat(100)}.tmp`), "x");
    const scan = runCli([
      "scan",
      tmpDir,
      "--json",
      "--pattern",
      "*.tmp",
      "--select",
      "all",
      "--include-dangerous",
    ]);
    expect(scan.exitCode).toBe(0);
    const planFile = dir("reviewed-plan.json");
    writeFileSync(planFile, scan.stdout);
    for (const args of [
      [tmpDir, "--dry-run", "--json", "--engine", "js", "--pattern", "*.tmp"],
      ["apply", "--plan", planFile, "--dry-run", "--json", "--engine", "js"],
    ]) {
      const proc = Bun.spawn({
        cmd: ["bun", SWEEP, ...args],
        cwd: REPO_ROOT,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, SWEEP_CONFIG_DIR: dir("test-config") },
      });
      const stderr = new Response(proc.stderr).text();
      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const plan = JSON.parse(await new Response(proc.stdout).text()) as ScanPlan;
        expect(await proc.exited).toBe(0);
        expect(plan.candidates).toHaveLength(count);
        expect(await stderr).not.toContain("output is incomplete");
        expect(existsSync(dir(`${0}-${"x".repeat(100)}.tmp`))).toBe(true);
      } finally {
        if (proc.exitCode === null) proc.kill();
      }
    }
  }, 15_000);

  test("status --json emits a small summary and never counts protected items", () => {
    mkdirSync(dir("node_modules"));
    writeFileSync(dir("node_modules", "a.bin"), "x".repeat(2048));
    mkdirSync(dir("target"));
    writeFileSync(dir("Cargo.toml"), "[package]\n");

    const result = runCli(["status", tmpDir, "--json"]);

    expect(result.exitCode).toBe(0);
    const status = JSON.parse(result.stdout) as StatusSummary;
    expect(status.protocolVersion).toBe("1");
    expect(status.targetDir.length).toBeGreaterThan(0);
    expect(status.reclaimableBytes).toBe(status.safeBytes + status.cautionBytes);
    expect(status.kinds.map((entry) => entry.kind)).toContain("node_modules");
    expect(status.idle.days).toBe(30);
    expect(status.idle.windowMs).toBe(30 * 86_400_000);
    expect(status.idle.windowLabel).toBe("30+ days");
    expect(status.complete).toBe(true);
    expect(status.skippedDirs).toBe(0);
    expect(status.bytesPartial).toBe(false);
    expect(status.finishedWorktrees.projects).toBe(0);
    expect(status.branchMissingWorktrees.projects).toBe(0);
    // A summary, not a plan: no candidate list to parse.
    expect(Object.hasOwn(status, "candidates")).toBe(false);
  });

  test("status reports guarded-only wording and exact sub-day idle window", () => {
    // Unmarked `target` (no Cargo.toml) is classified as dangerous (guarded).
    mkdirSync(dir("target"));
    writeFileSync(dir("target", "notes.txt"), "x".repeat(1024));

    const human = runCli(["status", tmpDir, "--idle", "12h", "--no-color"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("Nothing automatically reclaimable here.");
    expect(human.stdout).toContain("1 guarded item(s) found");

    const json = runCli(["status", tmpDir, "--idle", "12h", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as StatusSummary;
    expect(parsed.reclaimableBytes).toBe(0);
    expect(parsed.protectedCount).toBe(1);
    expect(parsed.protectedBytes).toBeGreaterThan(0);
    expect(parsed.idle.windowMs).toBe(12 * 3_600_000);
    expect(parsed.idle.windowLabel).toBe("12+ hours");
  });

  test("scan --json emits a plan-shaped document with candidates", () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("target"));
    writeFileSync(dir("Cargo.toml"), "[package]\n");

    const result = runCli(["scan", tmpDir, "--json"]);

    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(result.stdout) as ScanPlan & {
      candidates: Array<{ id: string; path: string; kind: string; riskTier: string }>;
      summary: { candidateCount: number; estimatedTotalBytes: number; scannedDirs: number };
    };

    expect(plan.protocolVersion).toBe("1");
    expect(plan.candidates).toHaveLength(2);
    expect(plan.selectedCandidateIds).toHaveLength(2);
    expect(plan.summary.candidateCount).toBe(2);
    expect(plan.candidates.every((candidate) => candidate.id.length > 0)).toBe(true);
  });

  test("scan --json-stream emits scan lifecycle events", () => {
    mkdirSync(dir("node_modules"));

    const result = runCli(["scan", tmpDir, "--json-stream"]);

    expect(result.exitCode).toBe(0);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ScanEvent);

    expect(events[0]?.type).toBe("scan_started");
    const found = events.filter((event) => event.type === "candidate_found");
    expect(found.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "candidate_updated")).toBe(true);
    expect(events.at(-1)?.type).toBe("scan_completed");
  });

  test("apply --plan deletes planned candidates and reports JSON results", () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("target"));
    writeFileSync(dir("Cargo.toml"), "[package]\n");

    const scanResult = runCli(["scan", tmpDir, "--json"]);
    expect(scanResult.exitCode).toBe(0);

    const planPath = dir("plan.json");
    writeFileSync(planPath, scanResult.stdout);

    const applyResult = runCli(["apply", "--plan", planPath, "--yes", "--json"]);

    expect(applyResult.exitCode).toBe(0);
    const report = JSON.parse(applyResult.stdout) as {
      deletedCount: number;
      failedCount: number;
      totalBytesFreed: number;
    };

    expect(report.deletedCount).toBe(2);
    expect(report.failedCount).toBe(0);
    expect(report.totalBytesFreed).toBeGreaterThanOrEqual(0);
    expect(existsSync(dir("node_modules"))).toBe(false);
    expect(existsSync(dir("target"))).toBe(false);
  });

  test("apply --dry-run reports the plan without deleting anything", () => {
    // A scripted "preview first" run parsed --dry-run but deleted anyway -
    // the flag must gate the destructive path, not just parse.
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("target"));
    writeFileSync(dir("Cargo.toml"), "[package]\n");

    const scanResult = runCli(["scan", tmpDir, "--json"]);
    expect(scanResult.exitCode).toBe(0);
    const planPath = dir("plan.json");
    writeFileSync(planPath, scanResult.stdout);

    const applyResult = runCli(["--dry-run", "apply", "--plan", planPath, "--yes", "--json"]);

    expect(applyResult.exitCode).toBe(0);
    expect(existsSync(dir("node_modules"))).toBe(true);
    expect(existsSync(dir("target"))).toBe(true);
  });

  test("--config pointing at a missing file is an error, not silent defaults", () => {
    mkdirSync(dir("node_modules"));

    const result = runCli(["--config", dir("does-not-exist.json"), "scan", tmpDir, "--json"]);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("does-not-exist.json");
  });

  test("--depth rejects a non-integer instead of running unbounded", () => {
    const result = runCli(["--depth", "abc", "scan", tmpDir, "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("expected an integer");
  });

  test("scan --json and --json-stream together conflict instead of double-emitting", () => {
    mkdirSync(dir("node_modules"));

    const result = runCli(["scan", tmpDir, "--json", "--json-stream"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("json");
  });

  test("scan excludes dangerous custom-pattern candidates from default selection", () => {
    mkdirSync(dir("custom-cache"));

    const result = runCli(["scan", tmpDir, "--json", "--pattern", "custom-cache"]);

    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(result.stdout) as ScanPlan & {
      candidates: Array<{ id: string; riskTier: string; reasons: string[] }>;
      summary: {
        candidateCount: number;
        selectedCount: number;
        riskCounts: Record<string, number>;
      };
    };

    expect(plan.summary.candidateCount).toBe(1);
    expect(plan.summary.selectedCount).toBe(0);
    expect(plan.selectedCandidateIds).toHaveLength(0);
    expect(plan.summary.riskCounts.dangerous).toBe(1);
    expect(plan.candidates[0]?.riskTier).toBe("dangerous");
    expect(plan.candidates[0]?.reasons).toContain("custom-pattern");
  });

  test("init scans first, writes only decisions, and never overwrites by surprise", () => {
    mkdirSync(dir("node_modules", "pkg"), { recursive: true });
    mkdirSync(dir("dist"));
    writeFileSync(dir("package.json"), "{}");
    writeFileSync(dir("dist", "a.js"), "x");

    const preview = runCli(["init", tmpDir, "--dry-run"]);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("node_modules");
    expect(preview.stdout).toContain("dist");
    expect(existsSync(dir(".sweeprc"))).toBe(false);

    // No terminal: opt-in names are reported, never silently enabled.
    const created = runCli(["init", tmpDir]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(dir(".sweeprc"), "utf8"))).toEqual({
      patterns: [],
      ignore: [],
      maxSizeGB: null,
    });

    const again = runCli(["init", tmpDir]);
    expect(again.exitCode).toBe(2);
    expect(again.stderr).toContain("already exists");
  });

  test.skipIf(process.platform === "win32")(
    "init under umask 002 produces a config that scan and doctor load cleanly, and refuses symlink/FIFO",
    () => {
      const umaskProject = dir("umask-002-project");
      mkdirSync(join(umaskProject, "node_modules", "pkg"), { recursive: true });
      const prevUmask = process.umask(0o002);
      try {
        const initRes = runCli(["init", umaskProject]);
        expect(initRes.exitCode).toBe(0);
      } finally {
        process.umask(prevUmask);
      }
      expect(statSync(join(umaskProject, ".sweeprc")).mode & 0o777).toBe(0o644);

      const scanRes = runCli(["scan", umaskProject, "--json"]);
      expect(scanRes.exitCode).toBe(0);

      const doctorRes = runCli(["doctor", umaskProject, "--json"]);
      const doctorDoc = JSON.parse(doctorRes.stdout) as {
        checks: Array<{ name: string; status: string; detail: string; reasonKind?: string }>;
      };
      expect(doctorDoc.checks.find((c) => c.name === "config")?.status).toBe("ok");
      expect(doctorDoc.checks.find((c) => c.name === "config_dir")?.status).toBe("ok");

      // World-writable sweep config directory causes doctor --json to warn with config_dir reasonKind.
      const unsafeConfigDir = dir("unsafe-config-dir");
      mkdirSync(unsafeConfigDir, { recursive: true });
      chmodSync(unsafeConfigDir, 0o777);
      const unsafeDoctorRes = runCli(["doctor", umaskProject, "--json"], {
        SWEEP_CONFIG_DIR: unsafeConfigDir,
      });
      expect(unsafeDoctorRes.exitCode).toBe(5);
      const unsafeDoctorDoc = JSON.parse(unsafeDoctorRes.stdout) as {
        checks: Array<{
          name: string;
          status: string;
          detail: string;
          reasonKind?: string;
          reason?: string;
        }>;
      };
      const unsafeConfigDirCheck = unsafeDoctorDoc.checks.find((c) => c.name === "config_dir");
      expect(unsafeConfigDirCheck?.status).toBe("warn");
      expect(unsafeConfigDirCheck?.reasonKind).toBe("world_writable");
      expect(unsafeConfigDirCheck?.reason).toContain(`chmod 700 ${unsafeConfigDir}`);
      expect(unsafeConfigDirCheck?.detail).toContain(`chmod 700 ${unsafeConfigDir}`);
      chmodSync(unsafeConfigDir, 0o700);

      // Symlink and FIFO targets are refused for both init and init --force.
      const linkProject = dir("symlink-init-project");
      mkdirSync(linkProject, { recursive: true });
      writeFileSync(dir("keep.txt"), "safe");
      symlinkSync(dir("keep.txt"), join(linkProject, ".sweeprc"));
      expect(runCli(["init", linkProject]).exitCode).toBe(3);
      expect(runCli(["init", linkProject, "--force"]).exitCode).toBe(3);
      expect(readFileSync(dir("keep.txt"), "utf8")).toBe("safe");

      const fifoProject = dir("fifo-init-project");
      mkdirSync(fifoProject, { recursive: true });
      execFileSync("mkfifo", [join(fifoProject, ".sweeprc")]);
      expect(runCli(["init", fifoProject]).exitCode).toBe(3);
      expect(runCli(["init", fifoProject, "--force"]).exitCode).toBe(3);
    },
  );

  test("an unattended run removes dangerous items only with --allow-dangerous", () => {
    mkdirSync(dir("custom-cache"));
    writeFileSync(dir("custom-cache", "keep.txt"), "x");
    const args = [
      tmpDir,
      "--pattern",
      "custom-cache",
      "--select",
      "all",
      "--include-dangerous",
      "-y",
    ];

    const refused = runCli(args);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("--allow-dangerous");
    expect(existsSync(dir("custom-cache", "keep.txt"))).toBe(true);

    const allowed = runCli([...args, "--allow-dangerous"]);
    expect(allowed.exitCode).toBe(0);
    // Consent is to named items: each one is printed before it goes.
    expect(allowed.stderr).toContain(dir("custom-cache"));
    expect(existsSync(dir("custom-cache"))).toBe(false);
  });

  test("scan can opt dangerous candidates back in with --include-dangerous", () => {
    mkdirSync(dir("custom-cache"));

    const result = runCli([
      "scan",
      tmpDir,
      "--json",
      "--pattern",
      "custom-cache",
      "--include-dangerous",
      "--select",
      "all",
    ]);

    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(result.stdout) as ScanPlan & {
      selectionPolicy: { mode: string; includeDangerous: boolean };
      summary: { selectedCount: number };
    };

    expect(plan.selectedCandidateIds).toHaveLength(1);
    expect(plan.summary.selectedCount).toBe(1);
    expect(plan.selectionPolicy).toEqual({
      mode: "all",
      includeDangerous: true,
    });
  });

  test("apply reports a revalidation failure when a candidate changes type", () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("target"));
    writeFileSync(dir("Cargo.toml"), "[package]\n");

    const scanResult = runCli(["scan", tmpDir, "--json"]);
    expect(scanResult.exitCode).toBe(0);

    const plan = JSON.parse(scanResult.stdout) as ScanPlan;
    const nodeModulesCandidate = plan.candidates.find(
      (candidate) => candidate.name === "node_modules",
    );
    expect(nodeModulesCandidate).toBeDefined();

    rmSync(dir("node_modules"), { recursive: true, force: true });
    writeFileSync(dir("node_modules"), "not a directory anymore");

    const planPath = dir("plan.json");
    writeFileSync(planPath, scanResult.stdout);

    const applyResult = runCli(["apply", "--plan", planPath, "--yes", "--json"]);
    expect(applyResult.exitCode).toBe(4);

    const report = JSON.parse(applyResult.stdout) as {
      deletedCount: number;
      failedCount: number;
      failedPaths: Array<{ path: string; error: string; code: string }>;
    };

    expect(report.deletedCount).toBe(1);
    expect(report.failedCount).toBe(1);
    expect(report.failedPaths[0]?.code).toBe("changed_entry_type");
    expect(report.failedPaths.some((failure) => failure.path === nodeModulesCandidate?.path)).toBe(
      true,
    );
  });

  test("legacy clean does not delete dangerous custom matches without explicit opt-in", () => {
    mkdirSync(dir("custom-cache"));

    const result = runCli([tmpDir, "--pattern", "custom-cache", "--yes"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(dir("custom-cache"))).toBe(true);
    expect(result.stdout).toContain("Nothing selected");
  });

  test("clean prompts before delete and aborts on decline", () => {
    mkdirSync(dir("node_modules"));

    const proc = Bun.spawnSync({
      cmd: ["bun", SWEEP, tmpDir],
      cwd: REPO_ROOT,
      stdin: Buffer.from("n\n"),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(1);
    expect(existsSync(dir("node_modules"))).toBe(true);
    // Prompts live on stderr - stdout stays clean for --json consumers.
    expect(Buffer.from(proc.stderr).toString("utf8")).toContain("Delete");
  });

  test("ui command refuses to run without a TTY", () => {
    mkdirSync(dir("node_modules"));

    const result = runCli(["ui", tmpDir]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("requires an interactive TTY");
  });

  test.skipIf(!NATIVE_CLI_AVAILABLE)("rust engine honors --pattern on scan --json", () => {
    mkdirSync(dir("custom-cache"));
    mkdirSync(dir("node_modules"));

    const result = runCli(
      ["scan", tmpDir, "--json", "--engine", "rust", "--pattern", "custom-cache"],
      { SWEEP_ENGINE_PATH: LOCAL_RUST_ENGINE },
    );

    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(result.stdout) as ScanPlan;
    const names = plan.candidates.map((candidate) => candidate.name).sort();
    expect(names).toContain("custom-cache");
    expect(names).toContain("node_modules");
  });
});

test.skipIf(process.platform === "win32")(
  "installed Node CLI trashes legal POSIX backslash names with exact receipts",
  () => {
    const target = dir("project");
    for (const parent of ["..\\x", "a\\b"]) {
      mkdirSync(join(target, parent, "node_modules"), { recursive: true });
      writeFileSync(join(target, parent, "node_modules", "keep"), parent);
    }
    const proc = Bun.spawnSync({
      cmd: ["node", SWEEP, "clean", target, "--engine", "js", "--trash", "--yes", "--json"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SWEEP_CONFIG_DIR: dir("config") },
    });
    expect({
      exitCode: proc.exitCode,
      stdout: Buffer.from(proc.stdout).toString(),
      stderr: Buffer.from(proc.stderr).toString(),
    }).toMatchObject({ exitCode: 0 });
    const report = JSON.parse(Buffer.from(proc.stdout).toString());
    expect(report.deletedCount).toBe(2);
    expect(report.failedCount).toBe(0);
    expect(report.trashMoves).toHaveLength(2);
    for (const move of report.trashMoves) {
      expect(existsSync(move.path)).toBe(false);
      expect(readFileSync(join(move.destination, "keep"), "utf8")).toBe(
        move.path.includes("..\\x") ? "..\\x" : "a\\b",
      );
    }
  },
);

test("JSON apply size refusal has a machine-readable stderr error and no journal", () => {
  mkdirSync(dir("node_modules"));
  writeFileSync(dir("node_modules", "keep"), "preserve");
  writeFileSync(dir(".sweeprc"), JSON.stringify({ maxSizeGB: 0.000000001 }));
  const scan = runCli(["scan", tmpDir, "--json"]);
  expect(scan.exitCode).toBe(0);
  writeFileSync(dir("plan.json"), scan.stdout);
  const result = runCli(["apply", "--plan", dir("plan.json"), "--yes", "--json"]);
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  const error = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
  expect(error).toMatchObject({
    type: "error",
    code: "size_limit_exceeded",
    applyOutcome: "not_started",
  });
  expect(readFileSync(dir("node_modules", "keep"), "utf8")).toBe("preserve");
  expect(existsSync(dir("test-config", "journals"))).toBe(false);
});

test("schema export provides the complete protocol vocabulary without scanning", () => {
  const result = runCli(["schema"]);
  expect(result.exitCode).toBe(0);
  const exported = JSON.parse(result.stdout);
  expect(exported.protocolVersion).toBe("1");
  expect(Object.keys(exported.schemas).sort()).toEqual([
    "applyReport",
    "scanEvent",
    "scanPlan",
    "shared",
  ]);
  expect(exported.schemas.scanPlan.$id).toBeDefined();
  expect(exported.schemas.applyReport.properties.outcomes).toBeDefined();
  expect(existsSync(dir("test-config"))).toBe(false);
});
