import { describe, expect, mock, test } from "bun:test";
import { handleKeymap, type KeymapActions, type KeymapContext } from "./keymap.js";
import { createUiState, type SweepUiState } from "./state.js";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";

function mockPlan(): ScanPlan {
  return {
    protocolVersion: "1",
    targetDir: "/tmp/sweep-ui",
    selectionPolicy: { mode: "default", includeDangerous: false },
    candidates: [
      {
        id: "cand_1",
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
    ],
    summary: {
      candidateCount: 1,
      estimatedTotalBytes: 1024,
      scannedDirs: 1,
      exact: false,
      selectedCount: 1,
      riskCounts: { safe: 1, caution: 0, dangerous: 0, blocked: 0 },
    },
    selectedCandidateIds: ["cand_1"],
    createdAt: new Date().toISOString(),
  };
}

describe("handleKeymap", () => {
  function makeContext(overrides: Partial<KeymapContext> = {}): KeymapContext {
    return {
      key: { name: "j" },
      state: createUiState(mockPlan()),
      showHelp: false,
      pendingApply: false,
      showSidebar: true,
      listSelectIndex: 0,
      pageRows: 10,
      ...overrides,
    };
  }

  function makeActions(): KeymapActions {
    return {
      finalize: mock(() => {}),
      mutate: mock((fn) => fn),
      focusPanel: mock(() => {}),
      setShowHelp: mock(() => {}),
      setPendingApply: mock(() => {}),
      requestApply: mock(() => {}),
      applyPlan: mock(() => {}),
      dismissScanError: mock(() => {}),
    };
  }

  describe("Ctrl+C", () => {
    // Raw mode means no SIGINT reaches the process, so if a mode swallows this
    // chord there is no way out of `sweep ui` at all. Every mode must honour it.
    const modes: Array<[string, Partial<KeymapContext>]> = [
      ["the artifact list", {}],
      ["the filter input", { state: { ...createUiState(mockPlan()), focus: "search" } }],
      ["the scope sidebar", { state: { ...createUiState(mockPlan()), focus: "sidebar" } }],
      ["the pattern editor", { state: { ...createUiState(mockPlan()), focus: "patterns" } }],
      ["the help overlay", { showHelp: true }],
      ["the apply confirmation", { pendingApply: true }],
      ["the scan-error modal", { scanError: "engine exploded" }],
    ];

    for (const [label, overrides] of modes) {
      test(`quits from ${label}`, () => {
        const actions = makeActions();
        handleKeymap(makeContext({ key: { name: "c", ctrl: true }, ...overrides }), actions);
        expect(actions.finalize).toHaveBeenCalledWith({ type: "abort" });
      });

      test(`quits from ${label} when the key arrives pre-combined`, () => {
        const actions = makeActions();
        handleKeymap(makeContext({ key: { name: "ctrl+c" }, ...overrides }), actions);
        expect(actions.finalize).toHaveBeenCalledWith({ type: "abort" });
      });
    }

    test("plain c is not a quit", () => {
      const actions = makeActions();
      handleKeymap(makeContext({ key: { name: "c" } }), actions);
      expect(actions.finalize).not.toHaveBeenCalled();
    });

    test("Ctrl+D still pages down rather than quitting", () => {
      const actions = makeActions();
      handleKeymap(makeContext({ key: { name: "d", ctrl: true } }), actions);
      expect(actions.finalize).not.toHaveBeenCalled();
      expect(actions.mutate).toHaveBeenCalled();
    });
  });

  test("Shift+Tab cycles focus in reverse", () => {
    const ctx = makeContext({
      key: { name: "tab", shift: true },
      state: { ...createUiState(mockPlan()), focus: "list" },
    });
    const actions = makeActions();
    handleKeymap(ctx, actions);
    expect(actions.focusPanel).toHaveBeenCalledWith("search");
  });

  test("Tab cycles focus forward", () => {
    const ctx = makeContext({
      key: { name: "tab", shift: false },
      state: { ...createUiState(mockPlan()), focus: "list" },
    });
    const actions = makeActions();
    handleKeymap(ctx, actions);
    expect(actions.focusPanel).toHaveBeenCalledWith("sidebar");
  });

  test("Search focus hands off to list on Down or Ctrl+N", () => {
    const ctx = makeContext({
      key: { name: "down" },
      state: { ...createUiState(mockPlan()), focus: "search" },
    });
    const actions = makeActions();
    handleKeymap(ctx, actions);
    expect(actions.focusPanel).toHaveBeenCalledWith("list");

    const ctxCtrlN = makeContext({
      key: { name: "n", ctrl: true },
      state: { ...createUiState(mockPlan()), focus: "search" },
    });
    const actionsCtrlN = makeActions();
    handleKeymap(ctxCtrlN, actionsCtrlN);
    expect(actionsCtrlN.focusPanel).toHaveBeenCalledWith("list");
  });

  test("Shift+g jumps to last item, g jumps to first", () => {
    const state = createUiState(mockPlan());
    const toLast = makeActions();
    handleKeymap(
      makeContext({ key: { name: "g", shift: true }, state: { ...state, focus: "list" } }),
      toLast,
    );
    expect(toLast.mutate).toHaveBeenCalled();

    const toFirst = makeActions();
    handleKeymap(
      makeContext({ key: { name: "g", shift: false }, state: { ...state, focus: "list" } }),
      toFirst,
    );
    expect(toFirst.mutate).toHaveBeenCalled();
  });

  test("escape in search clears the filter then returns to the list", () => {
    const ctx = makeContext({
      key: { name: "escape" },
      state: { ...createUiState(mockPlan()), focus: "search", filter: "node" },
    });
    const actions = makeActions();
    handleKeymap(ctx, actions);
    // The store is the only source of truth for the input, so clearing the
    // filter is all it takes for the text box to empty.
    const mutator = (actions.mutate as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[0] as (s: SweepUiState) => SweepUiState;
    expect(mutator(ctx.state).filter).toBe("");
    expect(actions.focusPanel).toHaveBeenCalledWith("list");
  });

  test("Ctrl+C aborts like q", () => {
    const actions = makeActions();
    handleKeymap(makeContext({ key: { name: "c", ctrl: true } }), actions);
    expect(actions.finalize).toHaveBeenCalledWith({ type: "abort" });
  });

  test("scan error modal traps keys until retry or dismiss", () => {
    const retry = makeActions();
    handleKeymap(makeContext({ key: { name: "j" }, scanError: "du failed" }), retry);
    expect(retry.mutate).not.toHaveBeenCalled();
    expect(retry.requestApply).not.toHaveBeenCalled();

    const rescan = makeActions();
    handleKeymap(makeContext({ key: { name: "r" }, scanError: "du failed" }), {
      ...rescan,
      requestRescan: mock(() => {}),
    });
    expect(rescan.dismissScanError).toHaveBeenCalled();
  });

  test("Ctrl+U and Ctrl+D page scrolling", () => {
    const ctxCtrlU = makeContext({
      key: { name: "u", ctrl: true },
      state: { ...createUiState(mockPlan()), focus: "list" },
    });
    const actionsCtrlU = makeActions();
    handleKeymap(ctxCtrlU, actionsCtrlU);
    expect(actionsCtrlU.mutate).toHaveBeenCalled();

    const ctxCtrlD = makeContext({
      key: { name: "d", ctrl: true },
      state: { ...createUiState(mockPlan()), focus: "list" },
    });
    const actionsCtrlD = makeActions();
    handleKeymap(ctxCtrlD, actionsCtrlD);
    expect(actionsCtrlD.mutate).toHaveBeenCalled();
  });
});
