import type { SweepUiState } from "./state.js";
import {
  applySidebarScope,
  clearSelection,
  escapeStep,
  expandAllGroups,
  moveCursor,
  moveSidebarCursor,
  rescanConfigFromState,
  selectSafeOnly,
  selectVisible,
  setRiskFilter,
  setThemeMode,
  toggleCurrentSelection,
  toggleGroup,
  togglePattern,
  toggleScopeExpand,
  collapseScopeFolder,
  setPatternIndex,
  setFilter,
  type UiFocus,
} from "./state.js";
import {
  buildDisplayRows,
  firstSelectableRow,
  lastSelectableRow,
  snapRowIndexToItem,
} from "./rows.js";
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
 * Ctrl+C — the terminal-wide "get me out" chord, honoured in every mode.
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
  const effective: UiFocus = current === "patterns" ? "list" : current;
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
  /** Cycle artifact ordering between size and name. */
  toggleSort?: () => void;
  /** Dismiss a scan-error modal without retrying. */
  dismissScanError?: () => void;
}

export interface KeymapContext {
  key: KeyInput;
  state: SweepUiState;
  showHelp: boolean;
  pendingApply: boolean;
  showSidebar: boolean;
  listSelectIndex: number;
  /** Visible rows in the artifact pane, for half-page scrolling. */
  pageRows?: number;
  /** Full scan failure shown as a modal; traps keys until dismissed. */
  scanError?: string | null;
}

/** Dispatch keyboard input by modal state and focused panel. */
export function handleKeymap(ctx: KeymapContext, actions: KeymapActions): void {
  const { key, state, showHelp, pendingApply, showSidebar, listSelectIndex, scanError } = ctx;

  // Quit is checked before every other branch. The terminal is in raw mode, so
  // no SIGINT is generated for us: if a modal or the filter input swallows this
  // key there is no other way out and `sweep ui` hangs.
  if (isQuitChord(key)) {
    actions.finalize({ type: "abort" });
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
    if (key.name === "y") {
      actions.setPendingApply(false);
      actions.applyPlan();
    } else if (key.name === "n" || key.name === "escape") {
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

  if (key.name === "escape") {
    // Walk back through narrowed views; esc NEVER quits the app.
    const step = escapeStep(state);
    if (step) actions.mutate(() => step);
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
    actions.focusPanel(state.focus === "patterns" ? "list" : "patterns");
    return;
  }

  if (key.name === "r") {
    if (actions.requestRescan) {
      actions.requestRescan();
      return;
    }
    const { disabledPatterns, extraPatterns } = rescanConfigFromState(state);
    actions.finalize({ type: "rescan", disabledPatterns, extraPatterns });
    return;
  }

  if (key.name === "o") {
    actions.toggleSort?.();
    return;
  }

  if (key.name === "/") {
    actions.focusPanel("search");
    return;
  }

  if (state.focus === "sidebar") {
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
      actions.mutate((s) => toggleScopeExpand(s));
      return;
    }
    if (key.name === "left" || key.name === "h") {
      actions.mutate((s) => collapseScopeFolder(s));
      return;
    }
    return;
  }

  if (state.focus === "patterns") {
    if (key.name === "space") {
      const pattern = state.catalogPatterns[listSelectIndex];
      if (pattern) actions.mutate((s) => togglePattern(s, pattern));
    }
    if (key.name === "up" || key.name === "k") {
      actions.mutate((s) => setPatternIndex(s, s.patternIndex - 1));
    } else if (key.name === "down" || key.name === "j") {
      actions.mutate((s) => setPatternIndex(s, s.patternIndex + 1));
    }
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
      default:
        break;
    }

    if (key.name === "return") {
      actions.requestApply();
      return;
    }
  }

  if (key.name === "space") {
    actions.mutate((s) => {
      const rows = buildDisplayRows(s);
      const row = rows[s.rowIndex];
      if (row?.kind === "header") return toggleGroup(s, row.groupKey);
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

  if (key.name === "u") {
    actions.mutate((s) => clearSelection(s));
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
