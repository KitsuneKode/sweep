import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import {
  PlanValidationError,
  loadPlan,
  validateApplyReport,
  validatePlan,
} from "@kitsunekode/sweep-core/plan";

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

  test("validatePlan accepts the optional modifiedMs on a candidate", () => {
    const plan = validPlan();
    plan.candidates[0] = { ...plan.candidates[0]!, modifiedMs: 1_760_000_000_000 };
    expect(validatePlan(plan).candidates[0]?.modifiedMs).toBe(1_760_000_000_000);
  });

  test("validatePlan rejects a negative or fractional modifiedMs", () => {
    for (const modifiedMs of [-1, 1.5]) {
      const plan = validPlan();
      plan.candidates[0] = { ...plan.candidates[0]!, modifiedMs };
      expect(() => validatePlan(plan)).toThrow();
    }
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
    const path = join(tmpdir(), `sweep-plan-load-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ not: "a plan" }));
    try {
      expect(() => loadPlan(path)).toThrow(PlanValidationError);
    } finally {
      unlinkSync(path);
    }
  });

  test("loadPlan rejects a directory path instead of reporting bad JSON", () => {
    // existsSync passes for directories - a dir argument must fail as
    // "not a file", not as an unparseable document.
    expect(() => loadPlan(tmpdir())).toThrow(/not a file/);
  });

  test("loadPlan rejects missing files with a clear error", () => {
    expect(() => loadPlan(join(tmpdir(), `sweep-no-such-plan-${Date.now()}.json`))).toThrow(
      /not found/,
    );
  });
});

describe("apply report validation", () => {
  test("validateApplyReport accepts a well-formed report", () => {
    const report = validateApplyReport({
      protocolVersion: "1",
      targetDir: "/tmp/x",
      selectedCandidateIds: ["cand_1"],
      deletedCount: 1,
      failedCount: 0,
      totalBytesFreed: 1024,
      failedPaths: [],
    });
    expect(report.deletedCount).toBe(1);
  });

  test("validateApplyReport accepts outside_target failure codes", () => {
    const report = validateApplyReport({
      protocolVersion: "1",
      targetDir: "/tmp/x",
      selectedCandidateIds: ["cand_1"],
      deletedCount: 0,
      failedCount: 1,
      totalBytesFreed: 0,
      failedPaths: [
        { path: "/tmp/x/node_modules", code: "outside_target", error: "resolves outside" },
      ],
    });
    expect(report.failedPaths[0]?.code).toBe("outside_target");
  });

  test("validateApplyReport rejects malformed engine output", () => {
    // SWEEP_ENGINE_PATH is user-overridable - engine stdout is untrusted and
    // a wrong-shaped report must fail loudly, not propagate as truth.
    expect(() => validateApplyReport({ deletedCount: "lots" })).toThrow(PlanValidationError);
    expect(() => validateApplyReport("null")).toThrow(PlanValidationError);
  });
});

test("rejects a plan whose candidate path is not in canonical form", () => {
  // A trailing separator makes lstat follow a leaf symlink - the delete-time
  // symlink check would never see it. sweep never writes this; a plan that
  // carries it is malformed input.
  const forged = validPlan();
  forged.candidates[0]!.path += "/";
  expect(() => validatePlan(forged)).toThrow("canonical");
});
