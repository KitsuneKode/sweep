import { describe, expect, mock, test } from "bun:test";
import { handleKeymap, type KeymapActions, type KeymapContext } from "./keymap.js";
import { createUiState } from "./state.js";
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
    };
  }

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

  test("s key triggers safe-only selection", () => {
    const ctx = makeContext({ key: { name: "s" } });
    const actions = makeActions();
    handleKeymap(ctx, actions);
    expect(actions.mutate).toHaveBeenCalled();
  });

  test("a key triggers bulk selection (safe + caution)", () => {
    const ctx = makeContext({ key: { name: "a" } });
    const actions = makeActions();
    handleKeymap(ctx, actions);
    expect(actions.mutate).toHaveBeenCalled();
  });

  test("u key clears current selection", () => {
    const ctx = makeContext({ key: { name: "u" } });
    const actions = makeActions();
    handleKeymap(ctx, actions);
    expect(actions.mutate).toHaveBeenCalled();
  });

  test("space key toggles focused candidate selection", () => {
    const ctx = makeContext({ key: { name: "space" } });
    const actions = makeActions();
    handleKeymap(ctx, actions);
    expect(actions.mutate).toHaveBeenCalled();
  });

  test("? key opens help overlay and q key aborts", () => {
    const ctxHelp = makeContext({ key: { name: "?" } });
    const actionsHelp = makeActions();
    handleKeymap(ctxHelp, actionsHelp);
    expect(actionsHelp.setShowHelp).toHaveBeenCalledWith(true);

    const ctxQuit = makeContext({ key: { name: "q" } });
    const actionsQuit = makeActions();
    handleKeymap(ctxQuit, actionsQuit);
    expect(actionsQuit.finalize).toHaveBeenCalledWith({ type: "abort" });
  });

  test("o key triggers toggleSort", () => {
    const toggleSort = mock(() => {});
    const ctx = makeContext({ key: { name: "o" } });
    const actions = { ...makeActions(), toggleSort };
    handleKeymap(ctx, actions);
    expect(toggleSort).toHaveBeenCalled();
  });

  test("r key triggers requestRescan", () => {
    const requestRescan = mock(() => {});
    const ctx = makeContext({ key: { name: "r" } });
    const actions = { ...makeActions(), requestRescan };
    handleKeymap(ctx, actions);
    expect(requestRescan).toHaveBeenCalled();
  });

  test("1-4 keys trigger risk filter changes", () => {
    for (const num of ["1", "2", "3", "4"]) {
      const ctx = makeContext({ key: { name: num } });
      const actions = makeActions();
      handleKeymap(ctx, actions);
      expect(actions.mutate).toHaveBeenCalled();
    }
  });

  test("hasScanError handles r to retry and q to abort", () => {
    const requestRescan = mock(() => {});
    const ctxRetry = makeContext({ key: { name: "r" }, hasScanError: true });
    const actionsRetry = { ...makeActions(), requestRescan };
    handleKeymap(ctxRetry, actionsRetry);
    expect(requestRescan).toHaveBeenCalled();

    const ctxAbort = makeContext({ key: { name: "q" }, hasScanError: true });
    const actionsAbort = makeActions();
    handleKeymap(ctxAbort, actionsAbort);
    expect(actionsAbort.finalize).toHaveBeenCalledWith({ type: "abort" });
  });
});
