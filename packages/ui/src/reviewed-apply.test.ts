import { describe, expect, test } from "bun:test";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { captureReviewedApply } from "./reviewed-apply.js";
import { createUiState } from "./state.js";

function candidate(id: string, riskTier: ScanCandidate["riskTier"]): ScanCandidate {
  return {
    id,
    path: `/work/${id}`,
    name: id,
    kind: "custom",
    estimatedBytes: 10,
    isSymlink: false,
    entryType: "directory",
    riskTier,
    reasons: [],
    selectedByDefault: false,
  };
}

function plan(): ScanPlan {
  const candidates = [
    candidate("safe", "safe"),
    candidate("caution", "caution"),
    candidate("danger", "dangerous"),
    candidate("blocked", "blocked"),
  ];
  return {
    protocolVersion: "1",
    targetDir: "/work",
    selectionPolicy: { mode: "default", includeDangerous: false },
    candidates,
    summary: {
      candidateCount: candidates.length,
      estimatedTotalBytes: 40,
      scannedDirs: 1,
      exact: true,
      selectedCount: 0,
      riskCounts: { safe: 1, caution: 1, dangerous: 1, blocked: 1 },
    },
    selectedCandidateIds: [],
    createdAt: "1970-01-01T00:00:00.000Z",
  };
}

describe("captureReviewedApply", () => {
  test("keeps only the ids the review named", () => {
    const source = plan();
    const captured = captureReviewedApply(source, createUiState(source), ["safe", "caution"]);
    expect(captured.selectedCandidateIds).toEqual(["safe", "caution"]);
    expect(captured.candidates.map((item) => item.id)).toEqual(["safe", "caution"]);
    expect(source.candidates).toHaveLength(4);
  });

  test("refuses a review that asked for a blocked id", () => {
    const source = plan();
    expect(() => captureReviewedApply(source, createUiState(source), ["safe", "blocked"])).toThrow(
      /review the queue again/,
    );
  });
});
