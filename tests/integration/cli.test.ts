import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ScanEvent, ScanPlan } from "@kitsunekode/sweep-protocol";

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

  test("scan --json emits a plan-shaped document with candidates", () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("target"));

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
