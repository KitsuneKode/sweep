import type { SweepUiState } from "./state.js";
import {
  clearSelection,
  moveCursor,
  moveSidebarCursor,
  applySidebarScope,
  rescanConfigFromState,
  selectVisible,
  setRiskFilter,
  setThemeMode,
  toggleCurrentSelection,
  togglePattern,
  type UiFocus,
} from "./state.js";
import { cycleThemeMode } from "./theme.js";
import type { SweepUiOutcome } from "./outcome.js";

export interface KeyInput {
  name?: string;
}

export interface KeymapActions {
  finalize: (outcome: SweepUiOutcome) => void;
  mutate: (fn: (state: SweepUiState) => SweepUiState) => void;
  focusPanel: (focus: UiFocus) => void;
  setShowHelp: (show: boolean) => void;
  setPendingApply: (pending: boolean) => void;
  requestApply: () => void;
  applyPlan: () => void;
}

export interface KeymapContext {
  key: KeyInput;
  state: SweepUiState;
  showHelp: boolean;
  pendingApply: boolean;
  showSidebar: boolean;
  listSelectIndex: number;
}

/** Dispatch keyboard input by modal state and focused panel. */
export function handleKeymap(ctx: KeymapContext, actions: KeymapActions): void {
  const { key, state, showHelp, pendingApply, showSidebar, listSelectIndex } = ctx;

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
    if (key.name === "?" || key.name === "escape") {
      actions.setShowHelp(false);
    }
    return;
  }

  if (state.focus === "search") {
    if (key.name === "escape" || key.name === "return") {
      actions.focusPanel("list");
    } else if (key.name === "tab") {
      actions.focusPanel(showSidebar ? "sidebar" : "list");
    }
    return;
  }

  if (key.name === "escape" || key.name === "q") {
    actions.finalize({ type: "abort" });
    return;
  }

  if (key.name === "?") {
    actions.setShowHelp(true);
    return;
  }

  if (key.name === "tab") {
    const order: UiFocus[] = showSidebar ? ["search", "sidebar", "list"] : ["search", "list"];
    const current = state.focus === "patterns" ? "list" : state.focus;
    const idx = order.indexOf(current);
    const next = order[(idx + 1) % order.length] ?? "list";
    actions.focusPanel(next);
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
    const { disabledPatterns, extraPatterns } = rescanConfigFromState(state);
    actions.finalize({ type: "rescan", disabledPatterns, extraPatterns });
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
    return;
  }

  if (state.focus === "patterns") {
    if (key.name === "space") {
      const pattern = state.catalogPatterns[listSelectIndex];
      if (pattern) actions.mutate((s) => togglePattern(s, pattern));
    }
    return;
  }

  if (state.focus === "list") {
    if (key.name === "up" || key.name === "k") {
      actions.mutate((s) => moveCursor(s, -1));
      return;
    }
    if (key.name === "down" || key.name === "j") {
      actions.mutate((s) => moveCursor(s, 1));
      return;
    }
    if (key.name === "return") {
      actions.requestApply();
      return;
    }
  }

  if (key.name === "space") {
    actions.mutate((s) => toggleCurrentSelection(s));
    return;
  }

  if (key.name === "s") {
    actions.mutate((s) => selectVisible(s, false));
    return;
  }

  if (key.name === "a") {
    actions.mutate((s) => selectVisible(s, true));
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
