import { describe, expect, test } from "bun:test";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import {
  applyUiSelection,
  clearSelection,
  createUiState,
  escapeStep,
  getCurrentCandidate,
  getUiSummary,
  getVisibleCandidates,
  moveCursor,
  resetForRescan,
  selectSafeOnly,
  selectVisible,
  setFilter,
  setScopeFilter,
  toggleCurrentSelection,
  toggleGroup,
  togglePattern,
  toggleSortBy,
  upsertCandidates,
} from "./state.js";
import { buildDisplayRows } from "./rows.js";

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
        path: "/tmp/sweep-ui/.git/objects",
        name: "objects",
        kind: "custom",
        estimatedBytes: 512,
        isSymlink: false,
        entryType: "directory",
        riskTier: "blocked",
        reasons: ["protected-vcs"],
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

    expect(getVisibleCandidates(state).map((candidate) => candidate.id)).toEqual([
      "cand_dangerous",
      "cand_blocked",
    ]);
  });

  test("cursor movement skips group headers and clamps to items", () => {
    let state = createUiState(createPlan());
    expect(state.rowIndex).toBe(1);

    state = moveCursor(state, 50);
    expect(state.rowIndex).toBe(4);

    state = moveCursor(state, -50);
    expect(state.rowIndex).toBe(1);
  });

  test("toggleCurrentSelection adds and removes the focused candidate", () => {
    let state = setFilter(createUiState(createPlan()), "node_modules");
    expect(getCurrentCandidate(state)?.id).toBe("cand_safe");
    expect(state.selectedIds.has("cand_safe")).toBe(true);

    state = toggleCurrentSelection(state);
    expect(state.selectedIds.has("cand_safe")).toBe(false);

    state = toggleCurrentSelection(state);
    expect(state.selectedIds.has("cand_safe")).toBe(true);
  });

  test("toggleCurrentSelection hard-locks blocked, allows deliberate dangerous", () => {
    let state = setFilter(createUiState(createPlan()), ".git");
    expect(getCurrentCandidate(state)?.riskTier).toBe("blocked");
    state = toggleCurrentSelection(state);
    expect(state.selectedIds.has("cand_blocked")).toBe(false);

    // Dangerous items CAN be toggled deliberately — the red confirm dialog is
    // the safety gate, not an unselectable row.
    state = setFilter(createUiState(createPlan()), "custom-cache");
    expect(getCurrentCandidate(state)?.riskTier).toBe("dangerous");
    state = toggleCurrentSelection(state);
    expect(state.selectedIds.has("cand_dangerous")).toBe(true);
  });

  test("selectVisible excludes dangerous and blocked candidates by default", () => {
    const state = selectVisible(createUiState(createPlan()), false);

    expect([...state.selectedIds]).toEqual(["cand_safe"]);
  });

  test("selectSafeOnly selects only safe risk tier candidates", () => {
    const state = selectSafeOnly(createUiState(createPlan()));

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
    let state = selectVisible(createUiState(createPlan()), true);
    const nextPlan = applyUiSelection(createPlan(), state);

    expect(nextPlan.selectedCandidateIds).toEqual(["cand_safe", "cand_dangerous"]);
    expect(nextPlan.summary.selectedCount).toBe(2);
  });

  test("applyUiSelection strips blocked candidates even if selected", () => {
    const base = createUiState(createPlan());
    const state = {
      ...base,
      selectedIds: new Set([...base.selectedIds, "cand_blocked"]),
    };

    const nextPlan = applyUiSelection(createPlan(), state);

    expect(nextPlan.selectedCandidateIds).toEqual(["cand_safe"]);
    expect(nextPlan.summary.selectedCount).toBe(1);
  });

  test("togglePattern marks patterns dirty and toggles disabled set", () => {
    const state = togglePattern(createUiState(createPlan()), "dist");
    expect(state.disabledPatterns.has("dist")).toBe(true);
    expect(state.patternsDirty).toBe(true);
  });

  test("setScopeFilter limits visible candidates to a scope", () => {
    const plan = createPlan();
    plan.candidates.push({
      id: "cand_nested",
      path: "/tmp/sweep-ui/apps/web/node_modules",
      name: "node_modules",
      kind: "node_modules",
      estimatedBytes: 100,
      isSymlink: false,
      entryType: "directory",
      riskTier: "safe",
      reasons: ["default-pattern"],
      selectedByDefault: true,
    });

    const scoped = setScopeFilter(createUiState(plan), "apps/web");
    expect(getVisibleCandidates(scoped).every((c) => c.path.includes("apps/web"))).toBe(true);
  });

  test("upsertCandidates streams in discoveries and replaces them when sized", () => {
    let state = createUiState({ ...createPlan(), candidates: [] });
    expect(state.candidates).toHaveLength(0);

    state = upsertCandidates(state, [
      {
        id: "cand_a",
        path: "/tmp/sweep-ui/node_modules",
        name: "node_modules",
        kind: "node_modules",
        estimatedBytes: 0,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: true,
      },
    ]);
    expect(state.candidates).toHaveLength(1);
    expect(state.candidates[0]?.estimatedBytes).toBe(0);

    // Sized re-upsert with the same deterministic id replaces the stub.
    state = upsertCandidates(state, [{ ...state.candidates[0]!, estimatedBytes: 4096 }]);
    expect(state.candidates).toHaveLength(1);
    expect(state.candidates[0]?.estimatedBytes).toBe(4096);
  });

  test("upsert keeps the cursor anchored to the focused artifact", () => {
    let state = createUiState(createPlan());
    state = setFilter(state, "node_modules");
    expect(getCurrentCandidate(state)?.id).toBe("cand_safe");

    state = upsertCandidates(state, [
      {
        id: "cand_new",
        path: "/tmp/sweep-ui/apps/cli/node_modules",
        name: "node_modules",
        kind: "node_modules",
        estimatedBytes: 300,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: true,
      },
    ]);
    expect(state.candidates).toHaveLength(4);
    expect(getCurrentCandidate(state)?.id).toBe("cand_safe");
  });

  test("toggleSortBy cycles size and name ordering", () => {
    let state = createUiState(createPlan());
    expect(state.sortBy).toBe("size");

    state = toggleSortBy(state);
    expect(state.sortBy).toBe("name");

    // Name ordering is visible in display rows (getVisibleCandidates only filters).
    const itemIds = buildDisplayRows(state)
      .filter((row) => row.kind === "item")
      .map((row) => (row.kind === "item" ? row.candidateId : ""));
    expect(itemIds).toEqual(["cand_dangerous", "cand_safe", "cand_blocked"]);

    state = toggleSortBy(state);
    expect(state.sortBy).toBe("size");
    const sizedIds = buildDisplayRows(state)
      .filter((row) => row.kind === "item")
      .map((row) => (row.kind === "item" ? row.candidateId : ""));
    // Largest first.
    expect(sizedIds).toEqual(["cand_dangerous", "cand_safe", "cand_blocked"]);
  });

  test("resetForRescan clears artifacts and selections but keeps view config", () => {
    let state = createUiState(createPlan());
    state = togglePattern(state, "dist");

    const reset = resetForRescan(state);

    expect(reset.candidates).toHaveLength(0);
    expect(reset.selectedIds.size).toBe(0);
    expect(reset.scanning).toBe(true);
    expect(reset.disabledPatterns.has("dist")).toBe(true);
  });

  test("toggleGroup hides group items but keeps the header row", () => {
    let state = createUiState(createPlan());
    const headerIndex = buildDisplayRows(state).findIndex((row) => row.kind === "header");
    const header = buildDisplayRows(state)[headerIndex];
    if (header?.kind !== "header") throw new Error("expected header row");
    expect(header.collapsed).toBe(false);

    state = toggleGroup(state, header.groupKey);

    const rows = buildDisplayRows(state);
    const collapsedHeader = rows[headerIndex];
    expect(collapsedHeader?.kind).toBe("header");
    if (collapsedHeader?.kind === "header") {
      expect(collapsedHeader.collapsed).toBe(true);
      // Header still reports the full item count even while folded.
      expect(collapsedHeader.itemCount).toBe(header.itemCount);
    }
    // Only the folded group's items disappear.
    const itemsBefore = header.itemCount;
    expect(rows.filter((row) => row.kind === "item")).toHaveLength(3 - itemsBefore);

    state = toggleGroup(state, header.groupKey);
    expect(buildDisplayRows(state).filter((row) => row.kind === "item")).toHaveLength(3);
  });

  test("escape ladder unwinds filters before scopes before text search", () => {
    let state = createUiState(createPlan());
    state = setFilter(state, "node_modules");
    state = { ...state, riskFilter: "safe" };

    const step1 = escapeStep(state);
    expect(step1?.riskFilter).toBe("all");

    const step2 = escapeStep(step1!);
    expect(step2?.filter).toBe("");

    // Nothing left to unwind.
    expect(escapeStep(step2!)).toBeNull();
  });

  test("esc from sidebar/patterns focus returns to the list, never quits", () => {
    const base = createUiState(createPlan());

    expect(escapeStep({ ...base, focus: "sidebar" })?.focus).toBe("list");
    expect(escapeStep({ ...base, focus: "patterns" })?.focus).toBe("list");
  });

  test("applyUiSelection preserves all discovered candidates and sets selectedCandidateIds", () => {
    const initialPlan: ScanPlan = {
      ...createPlan(),
      candidates: [],
    };
    let state = createUiState(initialPlan);
    state = upsertCandidates(state, createPlan().candidates);
    state = { ...state, selectedIds: new Set(["cand_safe", "cand_dangerous"]) };

    const finalizedPlan = applyUiSelection(initialPlan, state);
    expect(finalizedPlan.candidates).toHaveLength(3);
    expect(finalizedPlan.selectedCandidateIds).toEqual(["cand_safe", "cand_dangerous"]);
    expect(finalizedPlan.summary.candidateCount).toBe(3);
    expect(finalizedPlan.summary.selectedCount).toBe(2);
  });
});
