import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPlan, scanToPlan } from "../packages/core/src/engine.js";
import { DEFAULT_CONFIG } from "../packages/core/src/config.js";
import { cleanupSeededFixtures, seedScenario } from "./support/fixtures.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync("/tmp/sweep-engine-test-");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  cleanupSeededFixtures();
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

  test("applyPlan reports missing candidates with a stable failure code", async () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));

    const { plan } = scanToPlan(tmpDir, DEFAULT_CONFIG);

    rmSync(dir("dist"), { recursive: true, force: true });

    const applied = await applyPlan(plan);

    expect(applied.report.failedCount).toBe(1);
    expect(applied.report.failedPaths[0]?.code).toBe("missing");
    expect(applied.report.failedPaths[0]?.path).toBe(dir("dist"));
  });

  test("scanToPlan preserves a mixed workspace scenario as a stable plan shape", () => {
    mkdirSync(dir("packages", "web", "node_modules"), { recursive: true });
    mkdirSync(dir("packages", "api", "target"), { recursive: true });
    mkdirSync(dir("apps", "docs", ".next"), { recursive: true });
    mkdirSync(dir("apps", "docs", "custom-cache"), { recursive: true });

    const { plan } = scanToPlan(
      tmpDir,
      {
        ...DEFAULT_CONFIG,
        patterns: [...DEFAULT_CONFIG.patterns, "custom-cache"],
      },
      {
        selectionPolicy: { mode: "default", includeDangerous: false },
      },
    );

    expect(plan.summary.candidateCount).toBe(4);
    expect(plan.summary.selectedCount).toBe(3);
    expect(plan.summary.riskCounts.safe).toBe(3);
    expect(plan.summary.riskCounts.dangerous).toBe(1);
  });

  test("scanToPlan handles the seeded large-plan scenario predictably", () => {
    const fixture = seedScenario("large-plan");

    const { plan } = scanToPlan(
      fixture.root,
      {
        ...DEFAULT_CONFIG,
        patterns: [...DEFAULT_CONFIG.patterns, "custom-cache"],
      },
      {
        selectionPolicy: { mode: "default", includeDangerous: false },
      },
    );

    expect(plan.summary.candidateCount).toBeGreaterThan(12);
    expect(plan.summary.riskCounts.dangerous).toBeGreaterThan(0);
    expect(plan.summary.selectedCount).toBeGreaterThan(0);
  });
});
