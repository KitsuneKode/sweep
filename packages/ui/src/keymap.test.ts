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

  test("enter on a group header folds it instead of opening apply", () => {
    // Mouse clicks park the cursor on headers; the destructive dialog must
    // never be one stray enter away when the cursor has no artifact on it.
    const state: SweepUiState = {
      ...createUiState(mockPlan()),
      focus: "list",
      collapsedGroups: new Set([""]), // every row under the cursor is a header
      rowIndex: 0,
    };
    const actions = makeActions();
    handleKeymap(makeContext({ key: { name: "return" }, state }), actions);
    expect(actions.requestApply).not.toHaveBeenCalled();
    expect(actions.mutate).toHaveBeenCalled();
  });

  test("enter on an item still requests apply", () => {
    const actions = makeActions();
    handleKeymap(
      makeContext({
        key: { name: "return" },
        state: { ...createUiState(mockPlan()), focus: "list" },
      }),
      actions,
    );
    expect(actions.requestApply).toHaveBeenCalled();
  });

  test("shift+s exports the plan and never falls through to safe-only queueing", () => {
    for (const key of [{ name: "S" }, { name: "s", shift: true }]) {
      const actions = makeActions();
      actions.exportPlan = mock(() => {});
      handleKeymap(makeContext({ key }), actions);
      expect(actions.exportPlan).toHaveBeenCalledTimes(1);
      expect(actions.mutate).not.toHaveBeenCalled();
    }
  });

  test("q in the confirm dialog dismisses instead of quitting", () => {
    // One keystroke from "are you sure" to process exit would pair a confirm
    // gate with an instant escape hatch - the dialog cancels, never aborts.
    const actions = makeActions();
    handleKeymap(makeContext({ key: { name: "q" }, pendingApply: true }), actions);
    expect(actions.setPendingApply).toHaveBeenCalledWith(false);
    expect(actions.finalize).not.toHaveBeenCalled();
    expect(actions.applyPlan).not.toHaveBeenCalled();
  });

  test("i on a group header notifies instead of opening an empty modal", () => {
    // Every group emits a header row at index 0 (rows.ts), so rowIndex 0 is
    // always a header. The overlay doesn't render without a candidate, but
    // inspectOpen would still trap every key - an invisible modal is the
    // worst trap in the app.
    const actions = makeActions();
    actions.setInspect = mock(() => {});
    actions.notify = mock(() => {});
    handleKeymap(
      makeContext({
        key: { name: "i" },
        state: { ...createUiState(mockPlan()), rowIndex: 0 },
      }),
      actions,
    );
    expect(actions.setInspect).not.toHaveBeenCalled();
    expect(actions.notify).toHaveBeenCalledTimes(1);
  });

  test("artifact actions do not fire while the patterns pane owns the screen", () => {
    for (const key of [{ name: "o" }, { name: "S" }, { name: "s", shift: true }]) {
      const actions = makeActions();
      actions.notify = mock(() => {});
      actions.toggleSort = mock(() => {});
      actions.exportPlan = mock(() => {});
      handleKeymap(
        makeContext({
          key,
          state: { ...createUiState(mockPlan()), focus: "patterns" },
        }),
        actions,
      );
      expect(actions.toggleSort).not.toHaveBeenCalled();
      expect(actions.exportPlan).not.toHaveBeenCalled();
      expect(actions.notify).toHaveBeenCalled();
    }
  });

  test("a focus left on an unmounted sidebar reconciles to the list", () => {
    const actions = makeActions();
    handleKeymap(
      makeContext({
        key: { name: "j" },
        showSidebar: false,
        state: { ...createUiState(mockPlan()), focus: "sidebar" },
      }),
      actions,
    );
    expect(actions.focusPanel).toHaveBeenCalledWith("list");
    expect(actions.mutate).not.toHaveBeenCalled();
  });

  test("t in the confirm dialog toggles trash and does not cycle the theme", () => {
    const actions = makeActions();
    actions.toggleTrash = mock(() => {});
    handleKeymap(makeContext({ key: { name: "t" }, pendingApply: true }), actions);
    expect(actions.toggleTrash).toHaveBeenCalledTimes(1);
    expect(actions.mutate).not.toHaveBeenCalled();
    expect(actions.applyPlan).not.toHaveBeenCalled();
  });

  test("y yanks the cursor path from the list", () => {
    const actions = makeActions();
    actions.yankPath = mock(() => {});
    handleKeymap(makeContext({ key: { name: "y" } }), actions);
    expect(actions.yankPath).toHaveBeenCalledTimes(1);
  });

  test("v starts a visual range and v again cancels it", () => {
    const start = makeActions();
    handleKeymap(makeContext({ key: { name: "v" } }), start);
    const started = (start.mutate as ReturnType<typeof mock>).mock.calls[0]?.[0] as (
      s: SweepUiState,
    ) => SweepUiState;
    const anchored = started(createUiState(mockPlan()));
    expect(anchored.visualAnchorId).toBe("cand_1");

    const stop = makeActions();
    handleKeymap(makeContext({ key: { name: "v" }, state: anchored }), stop);
    const stopped = (stop.mutate as ReturnType<typeof mock>).mock.calls[0]?.[0] as (
      s: SweepUiState,
    ) => SweepUiState;
    expect(stopped(anchored).visualAnchorId).toBeNull();
  });

  test("space queues the range instead of the single row while in visual mode", () => {
    const actions = makeActions();
    actions.applyVisual = mock(() => {});
    const state = { ...createUiState(mockPlan()), visualAnchorId: "cand_1" };
    handleKeymap(makeContext({ key: { name: "space" }, state }), actions);
    expect(actions.applyVisual).toHaveBeenCalledTimes(1);
    expect(actions.mutate).not.toHaveBeenCalled();
  });

  test("i opens the inspect overlay and the overlay traps keys", () => {
    const open = makeActions();
    open.setInspect = mock(() => {});
    handleKeymap(
      makeContext({
        key: { name: "i" },
        state: { ...createUiState(mockPlan()), focus: "list" },
      }),
      open,
    );
    expect(open.setInspect).toHaveBeenCalledWith(true);

    // While open, navigation keys are trapped - the modal is the surface.
    const trapped = makeActions();
    trapped.setInspect = mock(() => {});
    handleKeymap(makeContext({ key: { name: "j" }, inspectOpen: true }), trapped);
    expect(trapped.mutate).not.toHaveBeenCalled();
    expect(trapped.setInspect).not.toHaveBeenCalled();

    for (const dismiss of ["escape", "i", "q", "return"]) {
      const actions = makeActions();
      actions.setInspect = mock(() => {});
      handleKeymap(makeContext({ key: { name: dismiss }, inspectOpen: true }), actions);
      expect(actions.setInspect).toHaveBeenCalledWith(false);
    }
  });

  test("space on a sidebar row requests the scope toggle", () => {
    // The app owns the toggle because the notice needs the skipped count.
    const state: SweepUiState = {
      ...createUiState(mockPlan()),
      focus: "sidebar",
      sidebarIndex: 0, // the "all scopes" row
      selectedIds: new Set(),
    };
    const actions = makeActions();
    actions.applyScopeToggle = mock(() => {});
    handleKeymap(makeContext({ key: { name: "space" }, state }), actions);
    expect(actions.applyScopeToggle).toHaveBeenCalled();
    expect(actions.mutate).not.toHaveBeenCalled();
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
