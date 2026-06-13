import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import { PlanValidationError, loadPlan, validatePlan } from "@kitsunekode/sweep-core/plan";

function validPlan(): ScanPlan {
  return {
    protocolVersion: "1",
    targetDir: "/tmp/sweep-plan-test/project",
    selectionPolicy: {
      mode: "default",
      includeDangerous: false,
    },
    candidates: [
      {
        id: "cand_1",
        path: "/tmp/sweep-plan-test/project/node_modules",
        name: "node_modules",
        kind: "node_modules",
        estimatedBytes: 1024,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: true,
      },
    ],
    summary: {
      candidateCount: 1,
      estimatedTotalBytes: 1024,
      scannedDirs: 2,
      exact: false,
      selectedCount: 1,
      riskCounts: {
        safe: 1,
        caution: 0,
        dangerous: 0,
        blocked: 0,
      },
    },
    selectedCandidateIds: ["cand_1"],
    createdAt: "2026-06-13T12:00:00.000Z",
  };
}

describe("plan validation", () => {
  test("validatePlan accepts a well-formed plan", () => {
    const plan = validatePlan(validPlan());
    expect(plan.protocolVersion).toBe("1");
    expect(plan.candidates).toHaveLength(1);
  });

  test("validatePlan rejects plans with wrong protocol version", () => {
    const invalid = { ...validPlan(), protocolVersion: "2" };
    expect(() => validatePlan(invalid)).toThrow(PlanValidationError);
  });

  test("validatePlan rejects plans missing required fields", () => {
    const { createdAt: _createdAt, ...invalid } = validPlan();
    expect(() => validatePlan(invalid)).toThrow(PlanValidationError);
  });

  test("validatePlan rejects candidates with invalid risk tier", () => {
    const plan = validPlan();
    plan.candidates[0]!.riskTier = "extreme" as ScanPlan["candidates"][number]["riskTier"];
    expect(() => validatePlan(plan)).toThrow(PlanValidationError);
  });

  test("loadPlan validates JSON from disk", () => {
    const path = `/tmp/sweep-plan-load-${Date.now()}.json`;
    writeFileSync(path, JSON.stringify({ not: "a plan" }));
    try {
      expect(() => loadPlan(path)).toThrow(PlanValidationError);
    } finally {
      unlinkSync(path);
    }
  });
});
