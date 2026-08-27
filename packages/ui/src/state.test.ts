import { describe, expect, test } from "bun:test";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
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
  setPatternIndex,
  setScanning,
  type SweepUiState,
} from "./state.js";
import { buildDisplayRows, firstItemRowIndex } from "./rows.js";

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

  test("cursor movement stays on selectable items and clamps to the list", () => {
    // Headings are chrome, not destinations: like cmdk, the cursor walks items
    // only, so the detail line and `space` always have a subject.
    let state = createUiState(createPlan());
    expect(state.rowIndex).toBe(1);
    expect(getCurrentCandidate(state)).toBeDefined();

    state = moveCursor(state, 50);
    expect(buildDisplayRows(state)[state.rowIndex]?.kind).toBe("item");
    expect(getCurrentCandidate(state)).toBeDefined();

    state = moveCursor(state, -50);
    expect(buildDisplayRows(state)[state.rowIndex]?.kind).toBe("item");
    expect(getCurrentCandidate(state)).toBeDefined();
  });

  test("stepping past the end of a group lands on the next item, not its heading", () => {
    let state = createUiState(createPlan());
    const rows = buildDisplayRows(state);
    const headerIndexes = rows
      .map((row, index) => (row.kind === "header" ? index : -1))
      .filter((index) => index >= 0);
    expect(headerIndexes.length).toBeGreaterThan(0);

    // Walk the whole list one step at a time; never rest on a heading.
    for (let i = 0; i < rows.length + 2; i++) {
      state = moveCursor(state, 1);
      expect(headerIndexes).not.toContain(state.rowIndex);
    }
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

  test("summary separates what is on screen from what is queued", () => {
    // cand_safe is queued but filtered out of view here.
    const state = setFilter(createUiState(createPlan()), "custom");
    const summary = getUiSummary(state);

    expect(summary.visibleCount).toBe(2);
    expect(summary.dangerousVisibleCount).toBe(1);
    expect(summary.visibleSelectedCount).toBe(0);

    // The queue is what apply acts on, so the totals must still count it.
    expect(summary.selectedCount).toBe(1);
    expect(summary.selectedBytes).toBe(1024);
  });

  test("summary totals always match what apply would delete", () => {
    // Regression: the confirm dialog read visible-only counts, so queuing
    // artifacts and then narrowing the view made it understate the damage —
    // it offered to delete 1 item while apply removed 3.
    const plan = createPlan();
    const narrowing: Array<[string, (s: SweepUiState) => SweepUiState]> = [
      ["no filter", (s) => s],
      ["text filter", (s) => setFilter(s, "node_modules")],
      ["scope filter", (s) => setScopeFilter(s, ".git")],
      ["filter with no matches", (s) => setFilter(s, "zzz-nothing-matches")],
    ];

    for (const [label, narrow] of narrowing) {
      const queued = selectVisible(createUiState(plan), true);
      const state = narrow(queued);
      const summary = getUiSummary(state);
      const applied = applyUiSelection(plan, state);

      expect(`${label}: ${summary.selectedCount}`).toBe(
        `${label}: ${applied.selectedCandidateIds.length}`,
      );

      const appliedBytes = applied.selectedCandidateIds.reduce((total, id) => {
        const candidate = state.candidates.find((entry) => entry.id === id);
        return total + (candidate?.estimatedBytes ?? 0);
      }, 0);
      expect(`${label}: ${summary.selectedBytes}`).toBe(`${label}: ${appliedBytes}`);
    }
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
    expect(reset.scannedDirs).toBe(0);
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
    expect(finalizedPlan.summary.estimatedTotalBytes).toBe(3584);
    expect(finalizedPlan.summary.riskCounts).toEqual({
      safe: 1,
      caution: 0,
      dangerous: 1,
      blocked: 1,
    });
  });

  test("setPatternIndex stays inside the catalog and does not snap to artifact rows", () => {
    const state = createUiState(createPlan());
    const next = {
      ...state,
      catalogPatterns: ["node_modules", "dist", "build"],
      rowIndex: 4,
    };
    const moved = setPatternIndex(next, 2);
    expect(moved.patternIndex).toBe(2);
    expect(moved.rowIndex).toBe(4);
    expect(moved.focus).toBe("patterns");
  });

  describe("order pinning across a live scan", () => {
    /** Discovery order is c, a, b; size order is the reverse. */
    function streamed() {
      const base = createUiState({
        ...createPlan(),
        candidates: [],
        selectedCandidateIds: [],
      });
      const make = (id: string, parent: string, bytes: number): ScanCandidate => ({
        id,
        path: `/tmp/sweep-ui/${parent}/node_modules`,
        name: "node_modules",
        kind: "node_modules",
        estimatedBytes: bytes,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: false,
      });
      return upsertCandidates(setScanning(base, true), [
        make("c", "apps/web", 100),
        make("a", "apps/cli", 200),
        make("b", "packages/core", 300),
      ]);
    }

    test("a scan pins the order and finishing unpins it", () => {
      const scanning = streamed();
      expect(scanning.scanning).toBe(true);
      expect(scanning.orderPinned).toBe(true);

      const done = setScanning(scanning, false);
      expect(done.scanning).toBe(false);
      expect(done.orderPinned).toBe(false);
    });

    test("an untouched cursor lands on the biggest win, not its old artifact", () => {
      // Nobody chose this row — it was auto-placed at the top when the first
      // batch arrived — so the sort should win over preserving it.
      const state = streamed();
      expect(state.rowIndex).toBe(firstItemRowIndex(buildDisplayRows(state)));

      const done = setScanning(state, false);
      const rows = buildDisplayRows(done);
      expect(done.rowIndex).toBe(firstItemRowIndex(rows));
      expect(getCurrentCandidate(done)?.id).toBe("b"); // largest
    });

    test("the cursor keeps its artifact through the closing re-sort", () => {
      let state = streamed();
      // Park on the last row in discovery order — a different row number once
      // the list re-sorts by size.
      state = { ...state, rowIndex: buildDisplayRows(state).length - 1 };
      const before = getCurrentCandidate(state);
      expect(before?.id).toBe("b");

      const done = setScanning(state, false);
      expect(getCurrentCandidate(done)?.id).toBe(before?.id);
      expect(buildDisplayRows(done)[done.rowIndex]?.kind).toBe("item");
    });

    test("a failed scan also unpins, so the list still sorts", () => {
      // app.tsx routes onError through setScanning(s, false) like a clean finish.
      expect(setScanning(streamed(), false).orderPinned).toBe(false);
    });

    test("an explicit sort unpins immediately rather than waiting", () => {
      const sorted = toggleSortBy(streamed());
      expect(sorted.orderPinned).toBe(false);
      expect(sorted.sortBy).toBe("name");
    });

    test("a rescan re-pins for the new generation", () => {
      const state = resetForRescan(setScanning(streamed(), false));
      expect(state.orderPinned).toBe(true);
      expect(state.scanning).toBe(true);
    });
  });
});
