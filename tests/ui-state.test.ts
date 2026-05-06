import { describe, expect, test } from "bun:test";
import type { ScanPlan } from "../packages/protocol/src/index.js";
import {
  applyUiSelection,
  clearSelection,
  createUiState,
  getCurrentCandidate,
  getUiSummary,
  getVisibleCandidates,
  moveCursor,
  selectVisible,
  setFilter,
  toggleCurrentSelection,
} from "../packages/ui/src/state.js";

function createPlan(): ScanPlan {
  return {
    protocolVersion: "1",
    targetDir: "/tmp/sweep-ui",
    selectionPolicy: {
      mode: "default",
      includeDangerous: false,
    },
    candidates: [
      {
        id: "cand_safe",
        path: "/tmp/sweep-ui/node_modules",
        name: "node_modules",
        kind: "node_modules",
        estimatedBytes: 1024,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: true,
      },
      {
        id: "cand_dangerous",
        path: "/tmp/sweep-ui/custom-cache",
        name: "custom-cache",
        kind: "custom",
        estimatedBytes: 2048,
        isSymlink: false,
        entryType: "directory",
        riskTier: "dangerous",
        reasons: ["custom-pattern"],
        selectedByDefault: false,
      },
      {
        id: "cand_blocked",
        path: "/tmp/sweep-ui/blocked",
        name: "blocked",
        kind: "custom",
        estimatedBytes: 512,
        isSymlink: false,
        entryType: "directory",
        riskTier: "blocked",
        reasons: ["guardrail"],
        selectedByDefault: false,
      },
    ],
    summary: {
      candidateCount: 3,
      estimatedTotalBytes: 3584,
      scannedDirs: 4,
      exact: false,
      selectedCount: 1,
      riskCounts: {
        safe: 1,
        caution: 0,
        dangerous: 1,
        blocked: 1,
      },
    },
    selectedCandidateIds: ["cand_safe"],
    createdAt: new Date().toISOString(),
  };
}

describe("sweep ui state", () => {
  test("filter narrows visible candidates by structured fields", () => {
    const state = setFilter(createUiState(createPlan()), "custom");

    expect(state.filteredIds).toEqual(["cand_dangerous", "cand_blocked"]);
    expect(getVisibleCandidates(state).map((candidate) => candidate.id)).toEqual([
      "cand_dangerous",
      "cand_blocked",
    ]);
  });

  test("cursor movement clamps to valid bounds", () => {
    let state = createUiState(createPlan());
    state = moveCursor(state, 50);
    expect(state.cursorIndex).toBe(2);

    state = moveCursor(state, -50);
    expect(state.cursorIndex).toBe(0);
  });

  test("toggleCurrentSelection adds and removes the focused candidate", () => {
    let state = createUiState(createPlan());
    expect(state.selectedIds.has("cand_safe")).toBe(true);

    state = toggleCurrentSelection(state);
    expect(state.selectedIds.has("cand_safe")).toBe(false);

    state = toggleCurrentSelection(state);
    expect(state.selectedIds.has("cand_safe")).toBe(true);
  });

  test("selectVisible excludes dangerous and blocked candidates by default", () => {
    const state = selectVisible(createUiState(createPlan()), false);

    expect([...state.selectedIds]).toEqual(["cand_safe"]);
  });

  test("selectVisible can include dangerous candidates when requested", () => {
    const state = selectVisible(createUiState(createPlan()), true);

    expect(state.selectedIds.has("cand_safe")).toBe(true);
    expect(state.selectedIds.has("cand_dangerous")).toBe(true);
    expect(state.selectedIds.has("cand_blocked")).toBe(false);
  });

  test("clearSelection removes all current selections", () => {
    const state = clearSelection(createUiState(createPlan()));
    expect(state.selectedIds.size).toBe(0);
  });

  test("summary reflects visible selection count, bytes, and dangerous visibility", () => {
    const state = setFilter(createUiState(createPlan()), "custom");
    const summary = getUiSummary(state);

    expect(summary.visibleCount).toBe(2);
    expect(summary.selectedCount).toBe(0);
    expect(summary.selectedBytes).toBe(0);
    expect(summary.dangerousVisibleCount).toBe(1);
  });

  test("applyUiSelection syncs selected ids back into a plan", () => {
    let state = setFilter(createUiState(createPlan()), "custom-cache");
    expect(getCurrentCandidate(state)?.id).toBe("cand_dangerous");

    state = toggleCurrentSelection(state);
    const nextPlan = applyUiSelection(createPlan(), state);

    expect(nextPlan.selectedCandidateIds).toEqual(["cand_safe", "cand_dangerous"]);
    expect(nextPlan.summary.selectedCount).toBe(2);
  });
});
