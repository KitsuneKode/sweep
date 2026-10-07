import type { SweepUiState } from "./state.js";
import {
  applySidebarScope,
  cancelVisual,
  clearSelection,
  clearVisibleSelection,
  escapeStep,
  expandAllGroups,
  moveCursor,
  moveSidebarCursor,
  patternAtCursor,
  removeCustomPattern,
  rescanConfigFromState,
  selectSafeOnly,
  selectVisible,
  setPatternInput,
  setRiskFilter,
  setThemeMode,
  toggleCurrentSelection,
  toggleGroup,
  togglePattern,
  expandScopeFolder,
  collapseScopeFolder,
  setPatternIndex,
  setFilter,
  startVisual,
  type UiFocus,
} from "./state.js";
import { buildDisplayRows, firstSelectableRow, lastSelectableRow } from "./rows.js";
import { cycleThemeMode } from "./theme.js";
import type { SweepUiOutcome } from "./outcome.js";

export interface KeyInput {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}

const DEFAULT_PAGE_ROWS = 12;

/**
 * Ctrl+C - the terminal-wide "get me out" chord, honoured in every mode.
 * Ctrl+D is deliberately excluded: it is bound to half-page-down here.
 */
export function isQuitChord(key: KeyInput): boolean {
  if (key.name === "ctrl+c") return true;
  return key.ctrl === true && key.name === "c";
}

function pageRows(ctx: KeymapContext): number {
  return ctx.pageRows ?? DEFAULT_PAGE_ROWS;
}

/** Next pane in the tab cycle; wraps in the requested direction. */
function nextFocus(current: UiFocus, showSidebar: boolean, reverse: boolean): UiFocus {
  const order = focusOrder(showSidebar);
  // The patterns editor is opened/closed with p, not part of the main cycle.
  const effective: UiFocus =
    current === "patterns" || current === "patternInput" ? "list" : current;
  const idx = order.indexOf(effective);
  const delta = reverse ? -1 : 1;
  return order[(idx + delta + order.length) % order.length] ?? "list";
}

function focusOrder(showSidebar: boolean): UiFocus[] {
  return showSidebar ? ["list", "sidebar", "search"] : ["list", "search"];
}

/** Collapse every group; cursor snaps to the first visible item. */
function collapseAllGroups(state: SweepUiState): SweepUiState {
  const rows = buildDisplayRows(state);
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.kind === "header") keys.add(row.groupKey);
  }
  if (keys.size === 0 || keys.size === state.collapsedGroups.size) return state;

  const collapsedGroups = keys;
  const nextRows = buildDisplayRows({ ...state, collapsedGroups });
  return {
    ...state,
    collapsedGroups,
    rowIndex: firstSelectableRow(nextRows),
  };
}

/** Jump to the first (-Infinity) or last (Infinity) selectable item row. */
function jumpCursor(state: SweepUiState, direction: number): SweepUiState {
  const rows = buildDisplayRows(state);
  if (rows.length === 0) return state;
  return {
    ...state,
    rowIndex: direction < 0 ? firstSelectableRow(rows) : lastSelectableRow(rows),
  };
}

/** Expand the nearest collapsed header at or above the cursor. */
function expandCurrentGroup(state: SweepUiState): SweepUiState {
  if (state.collapsedGroups.size === 0) return state;
  const rows = buildDisplayRows(state);
  for (let i = Math.min(state.rowIndex, rows.length - 1); i >= 0; i--) {
    const row = rows[i];
    if (row?.kind === "header" && row.collapsed) {
      return toggleGroup(state, row.groupKey);
    }
  }
  return state;
}

/** Collapse the group containing the focused item (nearest header above cursor). */
function collapseCurrentGroup(state: SweepUiState): SweepUiState {
  const rows = buildDisplayRows(state);
  for (let i = Math.min(state.rowIndex, rows.length - 1); i >= 0; i--) {
    const row = rows[i];
    if (row?.kind === "header") {
      if (row.collapsed) return state;
      return toggleGroup(state, row.groupKey);
    }
  }
  return state;
}

export interface KeymapActions {
  finalize: (outcome: SweepUiOutcome) => void;
  mutate: (fn: (state: SweepUiState) => SweepUiState) => void;
  focusPanel: (focus: UiFocus) => void;
  setShowHelp: (show: boolean) => void;
  setPendingApply: (pending: boolean) => void;
  requestApply: () => void;
  applyPlan: () => void;
  /** Restart the scan in place (streaming mode). Falls back to legacy rescan outcome. */
  requestRescan?: () => void;
  /**
   * Swap the scan backend (js ↔ rust) and rescan the same tree - developer
   * A/B surface for engine speed/parity comparisons. Streaming mode only.
   */
  toggleEngine?: () => void;
  /** Cycle artifact ordering: size, name, age. */
  toggleSort?: () => void;
  /** Dismiss a scan-error modal without retrying. */
  dismissScanError?: () => void;
  /** Open/close the per-candidate inspect overlay. */
  setInspect?: (open: boolean) => void;
  /** Flip "move to trash instead of deleting" inside the confirm dialog. */
  toggleTrash?: () => void;
  /** Write the reviewed plan (current queue) to a JSON file. */
  exportPlan?: () => void;
  /** Copy the cursor row's path to the clipboard. */
  yankPath?: () => void;
  /** Queue or unqueue the visual range, then leave visual mode. */
  applyVisual?: () => void;
  /** Ask for the confirm dialog on just the row under the cursor (x/d). */
  requestSingleApply?: () => void;
  /** Request confirmation for the candidate actually shown by inspect. */
  requestInspectedApply?: () => void;
  /** Confirm the scoped single-row apply (y while a single confirm is open). */
  confirmSingle?: () => void;
  /** Abort an in-session apply: stop scheduling, keep the report. */
  abortApply?: () => void;
  /** Queue or unqueue the scope under the sidebar cursor, then report skips. */
  applyScopeToggle?: () => void;
  /** Persist the pattern pane's edits as a project .sweeprc (w key). */
  writeSweeprc?: (overwrite: boolean) => void;
  /** Commit the add-pattern draft (enter on the pattern input in add mode). */
  submitPatternDraft?: () => void;
  /** Flash a one-line notice for a keypress that deliberately does nothing. */
  notify?: (message: string) => void;
  /**
   * Read state post-commit (flushes queued mutations first). ctx.state is the
   * last *rendered* snapshot: a multi-key stdin drain (paste, tmux send-keys,
   * SSH coalescing) runs several keys through one snapshot, so any branch
   * that picks a row or pattern must read fresh or act on a stale cursor.
   */
  readState?: () => SweepUiState;
  /**
   * Whether the confirm dialog has painted long enough for its destructive
   * keys to count as deliberate. Evaluated live at keypress time - a `y`/`t`
   * byte in the same stdin drain as the dialog's opener is leftover burst,
   * not an answer. Absent means "always armed" (tests, non-burst callers).
   */
  isConfirmArmed?: () => boolean;
}

export interface KeymapContext {
  key: KeyInput;
  state: SweepUiState;
  showHelp: boolean;
  pendingApply: boolean;
  showSidebar: boolean;
  /** Visible rows in the artifact pane, for half-page scrolling. */
  pageRows?: number;
  /** Full scan failure shown as a modal; traps keys until dismissed. */
  scanError?: string | null;
  /** Candidate-inspect overlay is open; traps keys until dismissed. */
  inspectOpen?: boolean;
  /**
   * The confirm dialog is scoped to one row (x/d), not the whole queue.
   * Only meaningful while pendingApply is true.
   */
  pendingSingle?: boolean;
  /** An in-session apply is in flight - keys wait for the report. */
  applying?: boolean;
}

/** Dispatch keyboard input by modal state and focused panel. */
export function handleKeymap(ctx: KeymapContext, actions: KeymapActions): void {
  const { key, state, showHelp, pendingApply, showSidebar, scanError, inspectOpen } = ctx;

  // Quit is checked before every other branch. The terminal is in raw mode, so
  // no SIGINT is generated for us: if a modal or the filter input swallows this
  // key there is no other way out and `sweep ui` hangs.
  if (isQuitChord(key)) {
    // Mid-apply ctrl-c means "stop the delete", not "leave with an unknown
    // tree state": the engine stops scheduling, reports what already ran,
    // and the session stays up to show it. Repeated Ctrl+C continues to
    // request cancellation; it must not destroy the pending report.
    if (ctx.applying) {
      actions.abortApply?.();
      return;
    }
    actions.finalize({ type: "abort" });
    return;
  }

  // While an in-session apply runs, every other key waits: the list the keys
  // would act on is being mutated by the engine.
  if (ctx.applying) {
    if (key.name === "escape") actions.abortApply?.();
    return;
  }

  const isShiftTab = (key.name === "tab" && key.shift) || key.name === "shift+tab";
  const isTab = key.name === "tab" && !key.shift;
  const isCtrlU = (key.name === "u" && key.ctrl) || key.name === "ctrl+u" || key.name === "pageup";
  const isCtrlD =
    (key.name === "d" && key.ctrl) || key.name === "ctrl+d" || key.name === "pagedown";
  const isShiftG = (key.name === "g" && key.shift) || key.name === "G" || key.name === "shift+g";

  if (scanError) {
    if (key.name === "r") {
      actions.dismissScanError?.();
      if (actions.requestRescan) {
        actions.requestRescan();
      }
      return;
    }
    if (key.name === "q") {
      actions.finalize({ type: "abort" });
      return;
    }
    if (key.name === "escape" || key.name === "n") {
      actions.dismissScanError?.();
    }
    return;
  }

  if (pendingApply) {
    if (key.name === "return" || key.name === "enter") {
      actions.notify?.("Press y to confirm, or n / Esc to cancel");
      return;
    }
    // Consequential keys (confirm, mode flip) need the dialog to have been
    // *seen*: a non-bracketed paste or scripted burst can carry y/t bytes
    // that arrive while the dialog is milliseconds old. The arm check runs
    // live at keypress time because the ctx snapshot predates the paint.
    // Dismissal keys stay live - closing a dialog early is always safe,
    // confirming early isn't.
    const confirmUnarmed = actions.isConfirmArmed !== undefined && !actions.isConfirmArmed();
    if (key.name === "t") {
      if (!confirmUnarmed) actions.toggleTrash?.();
      return;
    }
    if (key.name === "y") {
      if (confirmUnarmed) {
        actions.notify?.("Press y again after reviewing the confirmation");
        return;
      }
      if (ctx.pendingSingle) {
        actions.confirmSingle?.();
      } else {
        actions.applyPlan();
      }
      actions.setPendingApply(false);
    } else if (key.name === "n" || key.name === "escape" || key.name === "q") {
      // q dismisses like every other modal - quitting while a destructive
      // confirm is up would be one keystroke from intent to exit. Clearing
      // pendingApply also clears a single-row scope (the app owns both).
      actions.setPendingApply(false);
    }
    return;
  }

  if (showHelp) {
    if (key.name === "?" || key.name === "escape" || key.name === "q") {
      actions.setShowHelp(false);
    }
    return;
  }

  if (inspectOpen) {
    if (key.name === "x" || key.name === "d") {
      actions.requestInspectedApply?.();
      return;
    }
    if (key.name === "i" || key.name === "escape" || key.name === "q" || key.name === "return") {
      actions.setInspect?.(false);
    }
    return;
  }

  if (state.focus === "search") {
    if (key.name === "escape") {
      actions.mutate((s) => setFilter(s, ""));
      actions.focusPanel("list");
      return;
    }
    if (
      key.name === "return" ||
      key.name === "down" ||
      (key.name === "n" && key.ctrl) ||
      (key.name === "j" && key.ctrl)
    ) {
      actions.focusPanel("list");
      return;
    }
    if (isTab || isShiftTab) {
      actions.focusPanel(nextFocus(state.focus, showSidebar, isShiftTab));
    }
    return;
  }

  // The pattern pane's text line owns printable keys while focused - same as
  // the search box, keystrokes must never reach the artifact actions below.
  if (state.focus === "patternInput") {
    if (key.name === "escape") {
      actions.mutate((s) => escapeStep(s) ?? s);
      return;
    }
    if (key.name === "return") {
      // Same owner as the search box: the keymap, not the <input>'s onSubmit.
      // submitPatternDraft is idempotent if the input also emits onSubmit.
      if (state.patternInputMode === "add") {
        actions.submitPatternDraft?.();
      } else {
        actions.mutate((s) => setPatternInput(s, null));
      }
      return;
    }
    if (isTab || isShiftTab) {
      actions.mutate((s) => setPatternInput(s, null));
      actions.focusPanel(nextFocus("patterns", showSidebar, isShiftTab));
    }
    return;
  }

  if (key.name === "escape") {
    // Walk back through narrowed views; esc NEVER quits the app. Decide on
    // post-commit state AND re-derive the step inside the mutation - a step
    // captured from the pre-burst snapshot would wholesale-replace fresh
    // state, reverting selections the user made in the same drain.
    const step = escapeStep(actions.readState?.() ?? state);
    if (step) actions.mutate((s) => escapeStep(s) ?? s);
    else actions.notify?.("nothing to unwind: ctrl-c quits");
    return;
  }

  if (key.name === "q") {
    actions.finalize({ type: "abort" });
    return;
  }

  if (key.name === "?") {
    actions.setShowHelp(true);
    return;
  }

  if (isTab || isShiftTab) {
    actions.focusPanel(nextFocus(state.focus, showSidebar, isShiftTab));
    return;
  }

  if (key.name === "t") {
    actions.mutate((s) => setThemeMode(s, cycleThemeMode(s.themeMode)));
    return;
  }

  if (key.name === "p") {
    // patternInput returned earlier; reaching here means list/sidebar/patterns.
    actions.focusPanel(state.focus === "patterns" ? "list" : "patterns");
    return;
  }

  // Artifact-scope actions must not fire while the patterns pane owns the
  // screen: `o` sorts an invisible list and `S` exports a queue the user
  // isn't looking at. r (rescan) and t (theme) stay global - rescanning
  // after edits is the pane's point.
  if (
    state.focus === "patterns" &&
    (key.name === "o" || key.name === "S" || (key.name === "s" && key.shift))
  ) {
    actions.notify?.("finish in patterns first - esc leaves the pane");
    return;
  }

  // Shift+S must be claimed before plain `s` (safe-only queue) sees it.
  if (key.name === "S" || (key.name === "s" && key.shift)) {
    actions.exportPlan?.();
    return;
  }

  if (key.name === "r") {
    if (actions.requestRescan) {
      actions.requestRescan();
      return;
    }
    const { disabledPatterns, extraPatterns } = rescanConfigFromState(
      actions.readState?.() ?? state,
    );
    actions.finalize({ type: "rescan", disabledPatterns, extraPatterns });
    return;
  }

  if (key.name === "E" || (key.name === "e" && key.shift)) {
    // Lowercase e is collapse-all in list focus - E is intentionally global so
    // engine A/B works from any pane. Non-streaming mode has nothing to flip.
    if (actions.toggleEngine) {
      actions.toggleEngine();
    } else {
      actions.notify?.("engine switch needs a live scan - run `sweep ui`");
    }
    return;
  }

  if (key.name === "o") {
    actions.toggleSort?.();
    return;
  }

  if (key.name === "/") {
    // Inside the patterns pane, / narrows the catalog - the artifact filter
    // is the other pane's job. (patternInput never reaches this line.)
    if (state.focus === "patterns") {
      actions.mutate((s) => setPatternInput(s, "filter"));
    } else {
      actions.focusPanel("search");
    }
    return;
  }

  // The sidebar unmounts under a narrow resize while focus stays behind -
  // reconcile on the next keypress instead of leaving keys dead in a pane
  // that isn't rendered.
  if (state.focus === "sidebar" && !showSidebar) {
    actions.focusPanel("list");
    return;
  }

  if (
    (state.focus === "list" || state.focus === "sidebar") &&
    !key.ctrl &&
    !key.meta &&
    (key.name === "u" || key.name === "U")
  ) {
    const visibleOnly = key.name === "U" || key.shift === true;
    actions.mutate(visibleOnly ? clearVisibleSelection : clearSelection);
    actions.notify?.(
      visibleOnly
        ? "visible artifacts unqueued · hidden selections kept"
        : state.scanning
          ? "queue cleared · new discoveries stay unqueued"
          : "entire queue cleared",
    );
    return;
  }

  if (state.focus === "sidebar") {
    if (isCtrlU || isCtrlD) {
      actions.mutate((s) => moveSidebarCursor(s, (isCtrlU ? -1 : 1) * pageRows(ctx)));
      return;
    }
    if (isShiftG || key.name === "end") {
      actions.mutate((s) => moveSidebarCursor(s, Number.MAX_SAFE_INTEGER));
      return;
    }
    if (key.name === "g" || key.name === "home") {
      actions.mutate((s) => moveSidebarCursor(s, -Number.MAX_SAFE_INTEGER));
      return;
    }
    if (key.name === "up" || key.name === "k") {
      actions.mutate((s) => moveSidebarCursor(s, -1));
      return;
    }
    if (key.name === "down" || key.name === "j") {
      actions.mutate((s) => moveSidebarCursor(s, 1));
      return;
    }
    if (key.name === "return") {
      actions.mutate((s) => applySidebarScope(s));
      return;
    }
    if (key.name === "right" || key.name === "l") {
      actions.mutate((s) => expandScopeFolder(s));
      return;
    }
    if (key.name === "left" || key.name === "h") {
      actions.mutate((s) => collapseScopeFolder(s));
      return;
    }
    if (key.name === "space") {
      // Queue/dequeue the scope - the tree row is a checkbox group, not just a
      // filter. Dangerous and blocked entries stay out of bulk gestures.
      actions.applyScopeToggle?.();
      return;
    }
    return;
  }

  if (state.focus === "patterns") {
    if (isCtrlU) {
      actions.mutate((s) => setPatternIndex(s, s.patternIndex - pageRows(ctx)));
      return;
    }
    if (isCtrlD) {
      actions.mutate((s) => setPatternIndex(s, s.patternIndex + pageRows(ctx)));
      return;
    }
    if (isShiftG || key.name === "end") {
      actions.mutate((s) => setPatternIndex(s, Number.MAX_SAFE_INTEGER));
      return;
    }
    if (key.name === "g" || key.name === "home") {
      actions.mutate((s) => setPatternIndex(s, 0));
      return;
    }
    if (key.name === "up" || key.name === "k") {
      actions.mutate((s) => setPatternIndex(s, s.patternIndex - 1));
      return;
    }
    if (key.name === "down" || key.name === "j") {
      actions.mutate((s) => setPatternIndex(s, s.patternIndex + 1));
      return;
    }
    if (key.name === "space" || key.name === "return") {
      const pattern = patternAtCursor(actions.readState?.() ?? state);
      if (pattern) actions.mutate((s) => togglePattern(s, pattern));
      return;
    }
    if (key.name === "a") {
      actions.mutate((s) => setPatternInput(s, "add"));
      return;
    }
    if (key.name === "d" || key.name === "x") {
      const fresh = actions.readState?.() ?? state;
      const pattern = patternAtCursor(fresh);
      if (!pattern) return;
      if (fresh.catalogPatterns.includes(pattern)) {
        // Catalog rows toggle off instead of deleting - say so rather than
        // letting d look like a no-op.
        actions.notify?.("catalog entries toggle with space - d removes customs only");
        return;
      }
      actions.mutate((s) => removeCustomPattern(s, pattern));
      return;
    }
    // Shift+W is checked before plain w (same convention as S/s above).
    if (key.name === "W" || (key.name === "w" && key.shift)) {
      actions.writeSweeprc?.(true);
      return;
    }
    if (key.name === "w") {
      actions.writeSweeprc?.(false);
      return;
    }
    // Anything else is swallowed: pane-local focus means artifact keys must
    // not fire while the user is editing the scan definition.
    return;
  }

  if (state.focus === "list") {
    if (isCtrlU) {
      actions.mutate((s) => moveCursor(s, -pageRows(ctx)));
      return;
    }
    if (isCtrlD) {
      actions.mutate((s) => moveCursor(s, pageRows(ctx)));
      return;
    }

    switch (key.name) {
      case "up":
      case "k":
        actions.mutate((s) => moveCursor(s, -1));
        return;
      case "down":
      case "j":
        actions.mutate((s) => moveCursor(s, 1));
        return;
      case "home":
        actions.mutate((s) => jumpCursor(s, -Infinity));
        return;
      case "g":
        actions.mutate((s) => jumpCursor(s, isShiftG ? Infinity : -Infinity));
        return;
      case "G":
      case "shift+g":
      case "end":
        actions.mutate((s) => jumpCursor(s, Infinity));
        return;
      case "h":
      case "left":
        actions.mutate((s) => collapseCurrentGroup(s));
        return;
      case "l":
      case "right":
        actions.mutate((s) => expandCurrentGroup(s));
        return;
      case "e":
        actions.mutate(expandAllGroups);
        return;
      case "w":
        actions.mutate(collapseAllGroups);
        return;
      case "x":
      case "d":
        // Single-row apply: confirm dialog scoped to the cursor's candidate.
        // The app decides what a header row means (nothing to delete there).
        actions.requestSingleApply?.();
        return;
      default:
        break;
    }

    if (key.name === "return") {
      // Mouse clicks can park the cursor on a group header - enter there means
      // "fold this group" (same as space/l), never the destructive dialog.
      // Read post-commit rows: a same-burst cursor move must not misclassify
      // the row enter lands on.
      const fresh = actions.readState?.() ?? state;
      const row = buildDisplayRows(fresh)[fresh.rowIndex];
      if (row?.kind === "header") {
        actions.mutate((s) => toggleGroup(s, row.groupKey));
      } else {
        actions.requestApply();
      }
      return;
    }

    if (key.name === "i") {
      // Only open inspect when there's a real subject: the overlay doesn't
      // render without a candidate, but inspectOpen still traps every key -
      // an invisible modal is the worst trap in the app.
      const fresh = actions.readState?.() ?? state;
      const row = buildDisplayRows(fresh)[fresh.rowIndex];
      if (row?.kind === "item") {
        actions.setInspect?.(true);
      } else {
        actions.notify?.("nothing to inspect");
      }
      return;
    }

    if (key.name === "y") {
      actions.yankPath?.();
      return;
    }

    if (key.name === "v") {
      actions.mutate((s) => (s.visualAnchorId === null ? startVisual(s) : cancelVisual(s)));
      return;
    }
  }

  if (key.name === "space" && state.visualAnchorId !== null) {
    actions.applyVisual?.();
    return;
  }

  if (key.name === "space") {
    // Blocked rows can't be queued - say so instead of silently swallowing
    // the keypress (the ⊘ mark alone doesn't explain why nothing happened).
    const fresh = actions.readState?.() ?? state;
    const row = buildDisplayRows(fresh)[fresh.rowIndex];
    if (row?.kind === "item") {
      const candidate = fresh.candidates.find((c) => c.id === row.candidateId);
      if (candidate?.riskTier === "blocked") {
        actions.notify?.("⊘ protected path: blocked items can't be queued");
        return;
      }
    }
    actions.mutate((s) => {
      const rows = buildDisplayRows(s);
      const current = rows[s.rowIndex];
      if (current?.kind === "header") return toggleGroup(s, current.groupKey);
      return toggleCurrentSelection(s);
    });
    return;
  }

  if (key.name === "s") {
    actions.mutate((s) => selectSafeOnly(s));
    return;
  }

  if (key.name === "a") {
    // Bulk select is conservative by design: safe + caution only. Dangerous
    // items require an explicit per-item toggle, which then routes through
    // the red confirmation dialog before anything is deleted.
    actions.mutate((s) => selectVisible(s, false));
    return;
  }

  if (key.name === "1") {
    actions.mutate((s) => setRiskFilter(s, "all"));
    return;
  }
  if (key.name === "2") {
    actions.mutate((s) => setRiskFilter(s, "safe"));
    return;
  }
  if (key.name === "3") {
    actions.mutate((s) => setRiskFilter(s, "caution"));
    return;
  }
  if (key.name === "4") {
    actions.mutate((s) => setRiskFilter(s, "dangerous"));
  }
}
