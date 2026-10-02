import { describe, expect, mock, test } from "bun:test";
import { handleKeymap, type KeymapActions, type KeymapContext } from "./keymap.js";
import { createUiState, patternAtCursor, type SweepUiState } from "./state.js";
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

  test("E swaps the scan engine from any pane", () => {
    for (const key of [{ name: "E" }, { name: "e", shift: true }]) {
      for (const focus of ["list", "sidebar", "patterns"] as const) {
        const actions = makeActions();
        actions.toggleEngine = mock(() => {});
        handleKeymap(
          makeContext({
            key,
            state: { ...createUiState(mockPlan()), focus },
          }),
          actions,
        );
        expect(actions.toggleEngine).toHaveBeenCalledTimes(1);
      }
    }
  });

  test("E without a live scan notifies instead of crashing", () => {
    const actions = makeActions();
    actions.notify = mock(() => {});
    handleKeymap(makeContext({ key: { name: "E" } }), actions);
    expect(actions.notify).toHaveBeenCalled();
  });

  test("E never fires while a text field owns the keyboard", () => {
    // Typing an uppercase E into the search box or the pattern input must not
    // trigger an engine rescan - the input modes return before the binding.
    for (const focus of ["search", "patternInput"] as const) {
      const actions = makeActions();
      actions.toggleEngine = mock(() => {});
      handleKeymap(
        makeContext({
          key: { name: "E" },
          state: { ...createUiState(mockPlan()), focus },
        }),
        actions,
      );
      expect(actions.toggleEngine).not.toHaveBeenCalled();
    }
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

describe("single-row apply (x/d)", () => {
  function makeContext(overrides: Partial<KeymapContext> = {}): KeymapContext {
    return {
      key: { name: "x" },
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
    };
  }

  test("x and d on an item row request the scoped confirm", () => {
    const state = { ...createUiState(mockPlan()), focus: "list" as const };
    for (const name of ["x", "d"]) {
      const actions = makeActions();
      actions.requestSingleApply = mock(() => {});
      handleKeymap(makeContext({ key: { name }, state }), actions);
      expect(actions.requestSingleApply).toHaveBeenCalledTimes(1);
    }
  });

  test("x never reaches single apply from other panes", () => {
    for (const focus of ["patterns", "sidebar", "search"] as const) {
      const actions = makeActions();
      actions.requestSingleApply = mock(() => {});
      handleKeymap(makeContext({ state: { ...createUiState(mockPlan()), focus } }), actions);
      expect(actions.requestSingleApply).not.toHaveBeenCalled();
    }
  });

  test("y inside a single-scoped confirm calls confirmSingle, not applyPlan", () => {
    const actions = makeActions();
    actions.confirmSingle = mock(() => {});
    handleKeymap(
      makeContext({ key: { name: "y" }, pendingApply: true, pendingSingle: true }),
      actions,
    );
    expect(actions.confirmSingle).toHaveBeenCalledTimes(1);
    expect(actions.applyPlan).not.toHaveBeenCalled();
    expect(actions.setPendingApply).toHaveBeenCalledWith(false);
  });

  test("y inside a queue-scoped confirm still calls applyPlan", () => {
    const actions = makeActions();
    actions.confirmSingle = mock(() => {});
    handleKeymap(
      makeContext({ key: { name: "y" }, pendingApply: true, pendingSingle: false }),
      actions,
    );
    expect(actions.applyPlan).toHaveBeenCalledTimes(1);
    expect(actions.confirmSingle).not.toHaveBeenCalled();
  });

  test("an in-flight apply traps every key except ctrl-c", () => {
    const actions = makeActions();
    actions.abortApply = mock(() => {});
    actions.requestSingleApply = mock(() => {});
    for (const name of ["j", "x", "space", "return", "escape", "r"]) {
      handleKeymap(makeContext({ key: { name }, applying: true }), actions);
    }
    expect(actions.mutate).not.toHaveBeenCalled();
    expect(actions.requestSingleApply).not.toHaveBeenCalled();
    expect(actions.finalize).not.toHaveBeenCalled();
    expect(actions.abortApply).not.toHaveBeenCalled();
  });

  test("ctrl-c during apply aborts the apply, not the session", () => {
    const actions = makeActions();
    actions.abortApply = mock(() => {});
    handleKeymap(makeContext({ key: { name: "c", ctrl: true }, applying: true }), actions);
    expect(actions.abortApply).toHaveBeenCalledTimes(1);
    expect(actions.finalize).not.toHaveBeenCalled();
  });

  test("ctrl-c quits normally when no apply is in flight", () => {
    const actions = makeActions();
    handleKeymap(makeContext({ key: { name: "c", ctrl: true } }), actions);
    expect(actions.finalize).toHaveBeenCalledWith({ type: "abort" });
  });

  describe("input-burst freshness", () => {
    // OpenTUI's ConcurrentRoot only commits reducer work at the next render, so
    // a multi-key stdin drain (bracketed-less paste, tmux send-keys, SSH packet
    // coalescing) runs every key through one committed snapshot. These tests pin
    // that decisions which pick a row/pattern go through readState and that a
    // fresh confirm can't be confirmed by the burst that opened it.

    test("a y while the confirm is unarmed does not delete", () => {
      const actions = makeActions();
      actions.applyPlan = mock(() => {});
      actions.isConfirmArmed = mock(() => false);
      handleKeymap(makeContext({ key: { name: "y" }, pendingApply: true }), actions);
      expect(actions.applyPlan).not.toHaveBeenCalled();
      expect(actions.setPendingApply).not.toHaveBeenCalled();
    });

    test("an armed confirm accepts y normally", () => {
      const actions = makeActions();
      actions.applyPlan = mock(() => {});
      actions.isConfirmArmed = mock(() => true);
      handleKeymap(makeContext({ key: { name: "y" }, pendingApply: true }), actions);
      expect(actions.applyPlan).toHaveBeenCalledTimes(1);
    });

    test("a y with no arm check (test harnesses, legacy callers) still confirms", () => {
      const actions = makeActions();
      actions.applyPlan = mock(() => {});
      handleKeymap(makeContext({ key: { name: "y" }, pendingApply: true }), actions);
      expect(actions.applyPlan).toHaveBeenCalledTimes(1);
    });

    test("an unarmed confirm swallows t but never dismissal keys", () => {
      const armed = makeActions();
      armed.toggleTrash = mock(() => {});
      armed.isConfirmArmed = mock(() => false);
      handleKeymap(makeContext({ key: { name: "t" }, pendingApply: true }), armed);
      expect(armed.toggleTrash).not.toHaveBeenCalled();

      const dismiss = makeActions();
      dismiss.isConfirmArmed = mock(() => false);
      handleKeymap(makeContext({ key: { name: "n" }, pendingApply: true }), dismiss);
      expect(dismiss.setPendingApply).toHaveBeenCalledWith(false);
    });

    /** Capture the last fn handed to mutate so tests can apply it directly. */
    const lastMutateFn = (mutateMock: ReturnType<typeof mock>) =>
      mutateMock.mock.calls.at(-1)![0] as (s: SweepUiState) => SweepUiState;

    test("escape re-derives the unwind on committed state, not the snapshot", () => {
      const stale = createUiState(mockPlan());
      const committed = { ...stale, filter: "dist" };
      const actions = makeActions();
      const mutateMock = mock((fn: (s: SweepUiState) => SweepUiState) => fn);
      actions.mutate = mutateMock;
      actions.readState = () => committed;
      handleKeymap(makeContext({ key: { name: "escape" }, state: stale }), actions);
      expect(mutateMock).toHaveBeenCalled();
      const fn = lastMutateFn(mutateMock);
      // Applied to a state carrying ANOTHER layer, that layer must unwind -
      // a snapshot-derived step would have wholesale-replaced fresh state.
      const deeper = { ...committed, scopeFilter: "apps" };
      expect(fn(deeper).scopeFilter).toBeNull();
      // And a state with nothing to unwind passes through unchanged.
      expect(fn(stale)).toBe(stale);
    });

    test("two escapes in one drain unwind one layer each", () => {
      const committed = {
        ...createUiState(mockPlan()),
        filter: "a",
        scopeFilter: "apps" as const,
      };
      const actions = makeActions();
      const mutateMock = mock((fn: (s: SweepUiState) => SweepUiState) => fn);
      actions.mutate = mutateMock;
      actions.readState = () => committed;
      handleKeymap(makeContext({ key: { name: "escape" }, state: committed }), actions);
      const fn = lastMutateFn(mutateMock);
      const afterOne = fn(committed);
      expect(afterOne.scopeFilter).toBeNull();
      expect(afterOne.filter).toBe("a");
      // Second esc commits on the post-step state and peels the next layer.
      const afterTwo = fn(afterOne);
      expect(afterTwo.filter).toBe("");
    });

    test("enter acts on the post-move row, not the pre-burst cursor", () => {
      const stale = { ...createUiState(mockPlan()), rowIndex: 0 }; // header row
      const committed = { ...stale, rowIndex: 1 }; // cursor already moved to item
      const actions = makeActions();
      actions.requestApply = mock(() => {});
      actions.readState = () => committed;
      handleKeymap(makeContext({ key: { name: "return" }, state: stale }), actions);
      expect(actions.requestApply).toHaveBeenCalledTimes(1);
      expect(actions.mutate).not.toHaveBeenCalled();
    });

    test("enter on a post-move header folds instead of opening a confirm", () => {
      const stale = { ...createUiState(mockPlan()), rowIndex: 1 }; // item row
      const committed = { ...stale, rowIndex: 0 }; // moved up onto the header
      const actions = makeActions();
      const mutateMock = mock((fn: (s: SweepUiState) => SweepUiState) => fn);
      actions.mutate = mutateMock;
      actions.requestApply = mock(() => {});
      actions.readState = () => committed;
      handleKeymap(makeContext({ key: { name: "return" }, state: stale }), actions);
      expect(actions.requestApply).not.toHaveBeenCalled();
      const fn = lastMutateFn(mutateMock);
      expect(fn(committed).collapsedGroups.size).toBe(1);
    });

    test("i refuses to open inspect when the post-move row has no subject", () => {
      const stale = { ...createUiState(mockPlan()), rowIndex: 1 };
      const committed = { ...stale, rowIndex: 0 };
      const actions = makeActions();
      actions.setInspect = mock(() => {});
      actions.notify = mock(() => {});
      actions.readState = () => committed;
      handleKeymap(makeContext({ key: { name: "i" }, state: stale }), actions);
      expect(actions.setInspect).not.toHaveBeenCalled();
      expect(actions.notify).toHaveBeenCalled();
    });

    test("patterns space toggles the row the cursor committed to", () => {
      const stale = {
        ...createUiState(mockPlan()),
        focus: "patterns" as const,
        patternIndex: 0,
      };
      const committed = { ...stale, patternIndex: 1 };
      const actions = makeActions();
      const mutateMock = mock((fn: (s: SweepUiState) => SweepUiState) => fn);
      actions.mutate = mutateMock;
      actions.readState = () => committed;
      handleKeymap(makeContext({ key: { name: "space" }, state: stale }), actions);
      expect(mutateMock).toHaveBeenCalled();
      const fn = lastMutateFn(mutateMock);
      // The toggle must hit the pattern at the committed index - deriving the
      // name from the stale snapshot would flip the wrong row.
      const expected = patternAtCursor(committed);
      expect(expected).not.toBeNull();
      const out = fn(committed);
      expect(
        out.disabledPatterns.has(expected!) !== committed.disabledPatterns.has(expected!) ||
          out.extraPatterns.includes(expected!) !== committed.extraPatterns.includes(expected!),
      ).toBe(true);
    });
  });
});
