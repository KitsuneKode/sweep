import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScanEvent, ScanPlan } from "../packages/protocol/src/index.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync("/tmp/sweep-cli-test-");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const dir = (...parts: string[]) => join(tmpDir, ...parts);

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync({
    cmd: [Bun.which("bun") ?? "bun", "run", "packages/cli/src/index.ts", "--", ...args],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    stdout: Buffer.from(proc.stdout).toString("utf8"),
    stderr: Buffer.from(proc.stderr).toString("utf8"),
    exitCode: proc.exitCode,
  };
}

describe("CLI scan/apply", () => {
  test("scan --json emits a plan-shaped document with candidates", () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));

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
    expect(events.some((event) => event.type === "candidate_found")).toBe(true);
    expect(events.some((event) => event.type === "candidate_updated")).toBe(true);
    expect(events.at(-1)?.type).toBe("scan_completed");
  });

  test("apply --plan deletes planned candidates and reports JSON results", () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));

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
    expect(existsSync(dir("dist"))).toBe(false);
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
    mkdirSync(dir("dist"));

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
      failedPaths: Array<{ path: string; error: string }>;
    };

    expect(report.deletedCount).toBe(1);
    expect(report.failedCount).toBe(1);
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
});
