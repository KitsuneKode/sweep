import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPlan, scanToPlan } from "../packages/core/src/engine.js";
import { DEFAULT_CONFIG } from "../packages/core/src/config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync("/tmp/sweep-engine-test-");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const dir = (...parts: string[]) => join(tmpDir, ...parts);

describe("core engine", () => {
  test("scanToPlan returns both scan summary and a selected plan", () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));

    const { result, plan } = scanToPlan(tmpDir, DEFAULT_CONFIG);

    expect(result.entries).toHaveLength(2);
    expect(plan.candidates).toHaveLength(2);
    expect(plan.summary.candidateCount).toBe(2);
    expect(plan.summary.selectedCount).toBe(2);
  });

  test("applyPlan merges revalidation failures into the final report", async () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));

    const { plan } = scanToPlan(tmpDir, DEFAULT_CONFIG);

    rmSync(dir("node_modules"), { recursive: true, force: true });
    writeFileSync(dir("node_modules"), "drifted into a file");

    const applied = await applyPlan(plan);

    expect(applied.report.deletedCount).toBe(1);
    expect(applied.report.failedCount).toBe(1);
    expect(applied.report.failedPaths[0]?.path).toBe(dir("node_modules"));
    expect(applied.cleanResult.deleted).toHaveLength(1);
  });

  test("scanToPlan honors explicit selection policy", () => {
    mkdirSync(dir("custom-cache"));

    const { plan } = scanToPlan(
      tmpDir,
      {
        ...DEFAULT_CONFIG,
        patterns: [...DEFAULT_CONFIG.patterns, "custom-cache"],
      },
      {
        selectionPolicy: { mode: "all", includeDangerous: true },
      },
    );

    expect(plan.candidates).toHaveLength(1);
    expect(plan.selectedCandidateIds).toHaveLength(1);
    expect(plan.selectionPolicy).toEqual({
      mode: "all",
      includeDangerous: true,
    });
  });
});
