import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScanEntry, ScanResult } from "../packages/protocol/src/index.js";
import { buildPlan, revalidateCandidates, toCandidate } from "../packages/core/src/planner.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync("/tmp/sweep-planner-test-");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const dir = (...parts: string[]) => join(tmpDir, ...parts);

describe("planner", () => {
  test("buildPlan selects safe defaults and excludes dangerous custom patterns", () => {
    const safeEntry: ScanEntry = {
      path: dir("node_modules"),
      name: "node_modules",
      estimatedBytes: 10,
      isSymlink: false,
      entryType: "directory",
    };
    const dangerousEntry: ScanEntry = {
      path: dir("custom-cache"),
      name: "custom-cache",
      estimatedBytes: 5,
      isSymlink: false,
      entryType: "directory",
    };

    const result: ScanResult = {
      entries: [safeEntry, dangerousEntry],
      estimatedTotalBytes: 15,
      scannedDirs: 3,
      exact: false,
    };

    const plan = buildPlan(tmpDir, result);

    expect(plan.candidates).toHaveLength(2);
    expect(plan.selectedCandidateIds).toHaveLength(1);
    expect(plan.summary.selectedCount).toBe(1);
    expect(plan.summary.riskCounts.safe).toBe(1);
    expect(plan.summary.riskCounts.dangerous).toBe(1);
    expect(
      plan.candidates.find((candidate) => candidate.name === "custom-cache")?.selectedByDefault,
    ).toBe(false);
  });

  test("revalidateCandidates rejects entry type drift", () => {
    mkdirSync(dir("node_modules"));
    const candidate = toCandidate({
      path: dir("node_modules"),
      name: "node_modules",
      estimatedBytes: 0,
      isSymlink: false,
      entryType: "directory",
    });

    rmSync(dir("node_modules"), { recursive: true, force: true });
    writeFileSync(dir("node_modules"), "file now");

    const { ready, failedPaths } = revalidateCandidates([candidate]);

    expect(ready).toHaveLength(0);
    expect(failedPaths).toHaveLength(1);
    expect(failedPaths[0]?.error).toContain("entry type changed");
  });
});
