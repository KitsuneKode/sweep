import { describe, expect, test } from "bun:test";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { buildRescanConfig, DEFAULT_CONFIG } from "@kitsunekode/sweep-core/config";
import {
  allPatterns,
  applyUiSelection,
  applyVisualRange,
  clearSelection,
  createUiState,
  escapeStep,
  finalizeScan,
  getCurrentCandidate,
  getUiSummary,
  getVisibleCandidates,
  isCustomPattern,
  moveCursor,
  rescanConfigFromState,
  resetForRescan,
  selectSafeOnly,
  selectVisible,
  setFilter,
  setFocus,
  setRiskFilter,
  setRowIndex,
  setScopeFilter,
  startVisual,
  toggleCurrentSelection,
  toggleGroup,
  togglePattern,
  toggleScopeSelection,
  toggleSidebarScopeSelection,
  toggleSelectionById,
  toggleSortBy,
  upsertCandidates,
  visualRange,
  setPatternIndex,
  setPatternFilter,
  setScanning,
  addCustomPattern,
  removeCustomPattern,
  isPatternEnabled,
  patternAtCursor,
  patternPanelRows,
  visiblePatternRows,
  sweeprcPayload,
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

    // Dangerous items CAN be toggled deliberately - the red confirm dialog is
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
    // artifacts and then narrowing the view made it understate the damage -
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
    const state = togglePattern(createUiState(createPlan()), "node_modules");
    expect(state.disabledPatterns.has("node_modules")).toBe(true);
    expect(state.patternsDirty).toBe(true);
  });

  test("togglePattern on an opt-in catalog entry rides extraPatterns, not disabled", () => {
    // Opt-ins are off by omission, not by disable - toggling "dist" on must add
    // it to extras; toggling again removes it. It must never be written into
    // disabledPatterns (that list is for turning OFF shipping defaults).
    let state = togglePattern(createUiState(createPlan()), "dist");
    expect(state.extraPatterns).toContain("dist");
    expect(state.disabledPatterns.has("dist")).toBe(false);
    expect(isPatternEnabled(state, "dist")).toBe(true);

    state = togglePattern(state, "dist");
    expect(state.extraPatterns).not.toContain("dist");
    expect(isPatternEnabled(state, "dist")).toBe(false);
  });

  test("patternPanelRows groups the catalog and filters on name, ecosystem, or note", () => {
    let state = createUiState(createPlan());
    const rows = patternPanelRows(state);
    // Group headers interleave with pattern rows.
    expect(rows.some((r) => r.kind === "group" && r.label === "javascript")).toBe(true);
    expect(rows.some((r) => r.kind === "group" && r.label === "rust")).toBe(true);
    expect(rows.every((r) => r.kind !== "group" || typeof r.label === "string")).toBe(true);
    // Only pattern rows are selectable; headers never reach the cursor.
    expect(visiblePatternRows(state).every((r) => r.kind === "pattern")).toBe(true);

    state = setPatternFilter(state, "python");
    const filtered = visiblePatternRows(state);
    expect(filtered.length).toBeGreaterThan(0);
    // Every python catalog entry is opt-in - none ships enabled.
    expect(filtered.every((r) => r.source === "opt-in")).toBe(true);
    expect(patternAtCursor({ ...state, patternIndex: 0 })).toBe(filtered[0]?.pattern ?? null);
  });

  test("addCustomPattern dedupes, re-enables, and clears the draft", () => {
    let state = createUiState(createPlan());
    state = addCustomPattern({ ...state, patternDraft: "*.log" }, "*.log");
    expect(state.extraPatterns).toContain("*.log");
    expect(state.patternDraft).toBe("");
    expect(isPatternEnabled(state, "*.log")).toBe(true);

    // Adding again is a no-op, not a duplicate.
    state = addCustomPattern(state, "*.log");
    expect(state.extraPatterns.filter((p) => p === "*.log")).toHaveLength(1);
  });

  test("removeCustomPattern drops customs but never catalog entries", () => {
    let state = createUiState(createPlan(), { extraPatterns: ["*.bak"] });
    state = removeCustomPattern(state, "*.bak");
    expect(state.extraPatterns).not.toContain("*.bak");
    // Catalog rows can only be toggled off - removal is a no-op for them.
    const untouched = removeCustomPattern(state, "node_modules");
    expect(untouched.catalogPatterns).toContain("node_modules");
  });

  test("sweeprcPayload writes enabled extras to patterns and disabled defaults out", () => {
    let state = createUiState(createPlan(), { extraPatterns: ["*.bak"] });
    state = togglePattern(state, "node_modules"); // default off
    state = togglePattern(state, "dist"); // opt-in on
    state = togglePattern(state, "*.bak"); // custom off -> stays listed, lands nowhere

    const payload = sweeprcPayload(state);
    expect(payload.patterns).toContain("dist");
    expect(payload.patterns).not.toContain("*.bak"); // disabled custom is omitted
    expect(payload.disabledPatterns).toContain("node_modules");
    expect(payload.disabledPatterns).not.toContain("dist");
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

  test("toggleSortBy cycles size, name, then age ordering", () => {
    const plan = createPlan();
    const modified: Record<string, number> = { cand_safe: 1_000, cand_dangerous: 3_000 };
    let state = createUiState({
      ...plan,
      candidates: plan.candidates.map((candidate) =>
        modified[candidate.id] === undefined
          ? candidate
          : { ...candidate, modifiedMs: modified[candidate.id] as number },
      ),
    });
    const order = () =>
      buildDisplayRows(state)
        .filter((row) => row.kind === "item")
        .map((row) => (row.kind === "item" ? row.candidateId : ""));
    expect(state.sortBy).toBe("size");
    // Largest first.
    expect(order()).toEqual(["cand_dangerous", "cand_safe", "cand_blocked"]);

    state = toggleSortBy(state);
    expect(state.sortBy).toBe("name");
    // Name ordering is visible in display rows (getVisibleCandidates only filters).
    expect(order()).toEqual(["cand_dangerous", "cand_safe", "cand_blocked"]);

    state = toggleSortBy(state);
    expect(state.sortBy).toBe("age");
    // Stalest first; the candidate with no mtime sinks to the bottom.
    expect(order()).toEqual(["cand_safe", "cand_dangerous", "cand_blocked"]);

    state = toggleSortBy(state);
    expect(state.sortBy).toBe("size");
  });

  test("resetForRescan clears artifacts and selections but keeps view config", () => {
    let state = createUiState(createPlan());
    state = togglePattern(state, "node_modules");

    const reset = resetForRescan(state);

    expect(reset.candidates).toHaveLength(0);
    expect(reset.selectedIds.size).toBe(0);
    expect(reset.scanning).toBe(true);
    expect(reset.scannedDirs).toBe(0);
    expect(reset.disabledPatterns.has("node_modules")).toBe(true);
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

  test("allPatterns unions extras after the catalog without duplicating names", () => {
    const state = createUiState(createPlan(), {
      catalogPatterns: ["node_modules", "dist"],
      extraPatterns: ["*.bak", "dist", "tmp-*"],
    });

    expect(allPatterns(state)).toEqual(["node_modules", "dist", "*.bak", "tmp-*"]);
    expect(isCustomPattern(state, "*.bak")).toBe(true);
    expect(isCustomPattern(state, "dist")).toBe(false);
  });

  test("rescanConfigFromState hands extras and disabled patterns back for rescan", () => {
    let state = createUiState(createPlan(), { extraPatterns: ["*.bak"] });
    state = togglePattern(state, "*.bak");

    const ui = rescanConfigFromState(state);
    expect(ui.extraPatterns).toEqual(["*.bak"]);
    expect(ui.disabledPatterns).toEqual(["*.bak"]);

    const rebuilt = buildRescanConfig(DEFAULT_CONFIG, ui);
    expect(rebuilt.patterns).not.toContain("*.bak");
  });

  describe("streaming selection seeding", () => {
    function discovery(id: string, overrides: Partial<ScanCandidate> = {}): ScanCandidate {
      return {
        id,
        path: `/tmp/sweep-ui/${id}`,
        name: id,
        kind: "node_modules",
        estimatedBytes: 0,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: true,
        ...overrides,
      };
    }

    test("new discoveries queue themselves when selectedByDefault", () => {
      let state = createUiState({ ...createPlan(), candidates: [] });
      state = upsertCandidates(state, [
        discovery("a"),
        discovery("b", { selectedByDefault: false }),
        discovery("c", { riskTier: "blocked" }),
      ]);

      expect(state.selectedIds.has("a")).toBe(true);
      expect(state.selectedIds.has("b")).toBe(false);
      expect(state.selectedIds.has("c")).toBe(false);
    });

    test("a sized re-upsert never re-seeds a candidate the user dequeued", () => {
      let state = createUiState({ ...createPlan(), candidates: [] });
      state = upsertCandidates(state, [discovery("a")]);
      expect(state.selectedIds.has("a")).toBe(true);

      state = toggleSelectionById(state, "a");
      expect(state.selectedIds.has("a")).toBe(false);

      state = upsertCandidates(state, [discovery("a", { estimatedBytes: 999 })]);
      expect(state.selectedIds.has("a")).toBe(false);
      expect(state.candidates[0]?.estimatedBytes).toBe(999);
    });

    test("finalizeScan swaps stubs for enriched candidates and keeps user decisions", () => {
      let state = createUiState({ ...createPlan(), candidates: [] });
      state = setScanning(state, true);
      state = upsertCandidates(state, [discovery("a"), discovery("b")]);

      // Mid-scan the user dequeues b and deliberately queues a dangerous find.
      state = toggleSelectionById(state, "b");
      state = upsertCandidates(state, [
        discovery("d", { riskTier: "dangerous", selectedByDefault: false }),
      ]);
      state = toggleSelectionById(state, "d");
      expect(state.selectedIds.has("b")).toBe(false);
      expect(state.selectedIds.has("d")).toBe(true);

      const finalPlan: ScanPlan = {
        ...createPlan(),
        candidates: [
          discovery("a", { estimatedBytes: 10, reasons: ["enriched"] }),
          discovery("b", { estimatedBytes: 20 }),
          discovery("d", { riskTier: "dangerous", estimatedBytes: 30 }),
        ],
        selectedCandidateIds: ["a", "b"],
        summary: { ...createPlan().summary, selectedCount: 2 },
      };

      const done = finalizeScan(state, finalPlan);
      expect(done.scanning).toBe(false);
      expect(done.orderPinned).toBe(false);
      // Enriched candidate data wins over the stub.
      expect(done.candidates.find((c) => c.id === "a")?.reasons).toEqual(["enriched"]);
      // Untouched ids follow the plan policy; touched ids keep the user's call.
      expect(done.selectedIds.has("a")).toBe(true);
      expect(done.selectedIds.has("b")).toBe(false);
      expect(done.selectedIds.has("d")).toBe(true);
    });

    test("finalizeScan drops ids that vanished from the final plan", () => {
      let state = createUiState({ ...createPlan(), candidates: [] });
      state = upsertCandidates(state, [discovery("ghost")]);
      expect(state.selectedIds.has("ghost")).toBe(true);

      const done = finalizeScan(state, { ...createPlan(), candidates: [] });
      expect(done.selectedIds.size).toBe(0);
      expect(done.candidates).toHaveLength(0);
    });
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
      // Nobody chose this row - it was auto-placed at the top when the first
      // batch arrived - so the sort should win over preserving it.
      const state = streamed();
      expect(state.rowIndex).toBe(firstItemRowIndex(buildDisplayRows(state)));

      const done = setScanning(state, false);
      const rows = buildDisplayRows(done);
      expect(done.rowIndex).toBe(firstItemRowIndex(rows));
      expect(getCurrentCandidate(done)?.id).toBe("b"); // largest
    });

    test("the cursor keeps its artifact through the closing re-sort", () => {
      let state = streamed();
      // Park on the last row in discovery order - a different row number once
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

  describe("toggleScopeSelection", () => {
    test("null scope queues safe and caution, never dangerous or blocked", () => {
      const state = clearSelection(createUiState(createPlan()));
      const result = toggleScopeSelection(state, null);

      // Bulk gestures follow `a` and visual ranges: dangerous needs a
      // deliberate per-row toggle, blocked is hard-locked.
      expect([...result.state.selectedIds]).toEqual(["cand_safe"]);
      expect(result.queued).toBe(1);
      expect(result.skipped).toBe(2);
    });

    test("a scope key queues the subtree, including nested parents", () => {
      const base = clearSelection(createUiState(createPlan()));
      // ".git" holds only the blocked candidate - the toggle is a no-op there.
      const empty = toggleScopeSelection(base, ".git");
      expect(empty.state).toBe(base);
      expect(empty.skipped).toBe(1);

      const rootScoped = toggleScopeSelection(base, "");
      expect([...rootScoped.state.selectedIds]).toEqual(["cand_safe"]);
      expect(rootScoped.skipped).toBe(1); // cand_dangerous stayed out
    });

    test("a fully-queued scope toggles back off, leaving deliberate dangerous picks", () => {
      // createUiState seeds cand_safe; queueing cand_dangerous row-by-row is
      // the deliberate gesture the bulk toggle must not sweep away.
      const seeded = toggleSelectionById(createUiState(createPlan()), "cand_dangerous");
      expect(seeded.selectedIds.has("cand_dangerous")).toBe(true);

      const off = toggleScopeSelection(seeded, "");
      expect(off.state.selectedIds.has("cand_safe")).toBe(false);
      // The deliberate dangerous queue survives the bulk dequeue.
      expect(off.state.selectedIds.has("cand_dangerous")).toBe(true);
      expect(off.unqueued).toBe(1);
    });

    test("toggleSidebarScopeSelection drives the same toggle from the cursor row", () => {
      const state = clearSelection(createUiState(createPlan()));
      // sidebarIndex 0 is the "all scopes" row - a scope-level toggle of everything.
      const result = toggleSidebarScopeSelection({ ...state, sidebarIndex: 0 });
      expect([...result.state.selectedIds]).toEqual(["cand_safe"]);
      expect(result.skipped).toBe(2);
    });
  });
});

describe("visual range", () => {
  function tierPlan(): ScanPlan {
    const base = createPlan();
    const make = (
      id: string,
      name: string,
      riskTier: "safe" | "caution" | "dangerous" | "blocked",
      bytes: number,
    ) => ({
      id,
      path: `/tmp/sweep-ui/${name}`,
      name,
      kind: "custom" as const,
      estimatedBytes: bytes,
      isSymlink: false,
      entryType: "directory" as const,
      riskTier,
      reasons: [],
      selectedByDefault: false,
    });
    return {
      ...base,
      candidates: [
        make("a", "a", "safe", 500),
        make("b", "b", "caution", 400),
        make("c", "c", "dangerous", 300),
        make("d", "d", "blocked", 200),
        make("e", "e", "safe", 100),
      ],
      selectedCandidateIds: [],
    };
  }

  const itemIndex = (state: SweepUiState, id: string) =>
    buildDisplayRows(state).findIndex((row) => row.kind === "item" && row.candidateId === id);

  test("the range spans the anchor and the cursor in list order", () => {
    let state = startVisual(createUiState(tierPlan()));
    expect(state.visualAnchorId).toBe("a");
    state = setRowIndex(state, itemIndex(state, "c"));
    expect(visualRange(state)?.ids).toEqual(["a", "b", "c"]);
    // Extending upward past the anchor works too.
    state = { ...state, visualAnchorId: "e" };
    expect(visualRange(state)?.ids).toEqual(["c", "d", "e"]);
  });

  test("queues safe and caution rows but never dangerous or blocked ones", () => {
    let state = startVisual(createUiState(tierPlan()));
    state = setRowIndex(state, itemIndex(state, "e"));
    const result = applyVisualRange(state);
    expect([...result.state.selectedIds].sort()).toEqual(["a", "b", "e"]);
    expect(result.queued).toBe(3);
    expect(result.skipped).toBe(2);
    expect(result.state.visualAnchorId).toBeNull();
  });

  test("applying a fully queued range unqueues it", () => {
    let state = startVisual(createUiState(tierPlan()));
    state = setRowIndex(state, itemIndex(state, "b"));
    const queued = applyVisualRange(state).state;
    let again = startVisual(setRowIndex(queued, itemIndex(queued, "a")));
    again = setRowIndex(again, itemIndex(again, "b"));
    const result = applyVisualRange(again);
    expect(result.unqueued).toBe(2);
    expect(result.state.selectedIds.size).toBe(0);
  });

  test("esc drops the range before anything else unwinds", () => {
    const anchored = { ...startVisual(createUiState(tierPlan())), filter: "a" };
    const step = escapeStep(anchored);
    expect(step?.visualAnchorId).toBeNull();
    expect(step?.filter).toBe("a");
  });

  test("changing the filter or leaving the list abandons the range", () => {
    const anchored = startVisual(createUiState(tierPlan()));
    expect(setFilter(anchored, "a").visualAnchorId).toBeNull();
    expect(setRiskFilter(anchored, "safe").visualAnchorId).toBeNull();
    expect(setScopeFilter(anchored, "")?.visualAnchorId).toBeNull();
    expect(setFocus(anchored, "sidebar").visualAnchorId).toBeNull();
    expect(setFocus(anchored, "list").visualAnchorId).toBe("a");
  });

  test("a range whose anchor left the list is inert", () => {
    const anchored = startVisual(createUiState(tierPlan()));
    const filtered = { ...anchored, filter: "zzz" };
    expect(visualRange(filtered)).toBeNull();
    expect(applyVisualRange(filtered).state.selectedIds.size).toBe(0);
  });
});
