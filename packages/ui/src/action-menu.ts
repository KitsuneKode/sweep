import { formatBytes } from "@kitsunekode/sweep-display";
import { IDLE_WINDOW_DAYS } from "@kitsunekode/sweep-protocol";

export interface ActionMenuCommand {
  label: string;
  shortcut: string;
  run: () => void;
  disabled: boolean;
}
import {
  clearSelection,
  clearVisibleSelection,
  getCurrentCandidate,
  patternAtCursor,
  selectIdleSafe,
  selectSafeOnly,
  selectVisible,
  setFilter,
  setRiskFilter,
  setScopeFilter,
  setThemeMode,
  toggleSortBy,
  type SweepUiState,
  type SweepUiSummary,
} from "./state.js";
import { cycleThemeMode, type NoticeTone } from "./theme.js";

export interface BuildActionMenuOptions {
  state: SweepUiState;
  summary: SweepUiSummary;
  editingPatterns: boolean;
  idleSafeCount: number;
  idleSafeBytes: number;
  hasFolders: boolean;
  hasScan: boolean;
  motionEnabled: boolean;
  requestApply: () => void;
  setInspect: (open: boolean) => void;
  requestSingleApply: () => void;
  mutate: (fn: (s: SweepUiState) => SweepUiState) => void;
  setNotice: (text: string | null, tone?: NoticeTone) => void;
  focusPanel: (focus: SweepUiState["focus"]) => void;
  setJump: (open: boolean) => void;
  openFolderInfo: () => void;
  yankPath: () => void;
  exportPlan: () => void;
  writeSweeprc: () => void;
  inspectPattern: () => void;
  requestRescan: () => void;
  openPatternsView: () => void;
  toggleMotion: () => void;
  setShowHelp: (open: boolean) => void;
  setFilterPicker: (open: boolean) => void;
}

export function buildActionMenuCommands({
  state,
  summary,
  editingPatterns,
  idleSafeCount,
  idleSafeBytes,
  hasFolders,
  hasScan,
  motionEnabled,
  requestApply,
  setInspect,
  requestSingleApply,
  mutate,
  setNotice,
  focusPanel,
  setJump,
  openFolderInfo,
  yankPath,
  exportPlan,
  writeSweeprc,
  inspectPattern,
  requestRescan,
  openPatternsView,
  toggleMotion,
  setShowHelp,
  setFilterPicker,
}: BuildActionMenuOptions): ActionMenuCommand[] {
  const currentCandidate = getCurrentCandidate(state);
  return [
    {
      label: `Review queue (${summary.selectedCount})`,
      shortcut: "c",
      run: requestApply,
      disabled: state.scanning || state.scanIncomplete || summary.selectedCount === 0,
    },
    {
      label: "Inspect current item",
      shortcut: "i",
      run: () => setInspect(true),
      disabled: editingPatterns || !currentCandidate,
    },
    {
      label: "Review removal of current item",
      shortcut: "x",
      run: () => requestSingleApply(),
      disabled:
        state.scanning ||
        state.scanIncomplete ||
        editingPatterns ||
        !currentCandidate ||
        currentCandidate.riskTier === "blocked",
    },
    {
      // The recommendation: what nobody is using, across the whole target.
      label:
        idleSafeCount > 0
          ? `Queue safe items in projects idle ${IDLE_WINDOW_DAYS}+ days (${idleSafeCount.toLocaleString()} · ${formatBytes(idleSafeBytes)})`
          : `Queue safe items in projects idle ${IDLE_WINDOW_DAYS}+ days`,
      shortcut: "",
      run: () => {
        mutate(selectIdleSafe);
        setNotice(
          `queued ${idleSafeCount.toLocaleString()} items in idle projects · ${formatBytes(idleSafeBytes)}`,
          "success",
        );
      },
      disabled: editingPatterns || state.scanning || idleSafeCount === 0,
    },
    {
      label: "Queue safe items in this view",
      shortcut: "s",
      run: () => mutate(selectSafeOnly),
      disabled: editingPatterns,
    },
    {
      label: "Clear whole queue",
      shortcut: "u",
      run: () => mutate(clearSelection),
      disabled: summary.selectedCount === 0,
    },
    {
      label: "Clear queue in this view",
      shortcut: "Shift+U",
      run: () => mutate(clearVisibleSelection),
      disabled: editingPatterns || summary.visibleSelectedCount === 0,
    },
    {
      label: "Queue safe and caution items in this view",
      shortcut: "a",
      run: () => mutate((s) => selectVisible(s, false)),
      disabled: editingPatterns,
    },
    { label: "Filter items", shortcut: "/", run: () => focusPanel("search"), disabled: false },
    {
      label: "Clear search and risk filters",
      shortcut: "",
      run: () => mutate((s) => setFilter(setRiskFilter(s, "all"), "")),
      disabled: false,
    },
    {
      label: "Switch to another folder…",
      shortcut: "ctrl+o",
      run: () => setJump(true),
      disabled: !hasFolders,
    },
    {
      label: "Browse all folders",
      shortcut: "",
      run: () => mutate((s) => setScopeFilter(s, null)),
      disabled: false,
    },
    {
      label: "Current folder details",
      shortcut: "",
      run: openFolderInfo,
      disabled: false,
    },
    {
      label: "Copy current item path",
      shortcut: "y",
      run: yankPath,
      disabled: editingPatterns || !currentCandidate,
    },
    {
      label: "Save queue as a plan",
      shortcut: "Shift+S",
      run: exportPlan,
      disabled: state.scanning || state.scanIncomplete || summary.selectedCount === 0,
    },
    {
      label: "Save cleanup patterns",
      shortcut: "w",
      run: writeSweeprc,
      disabled:
        !editingPatterns || (state.focus === "patternInput" && state.patternInputMode === "add"),
    },
    {
      label: "Inspect current pattern",
      shortcut: "i",
      run: () => inspectPattern(),
      disabled: !editingPatterns || !patternAtCursor(state),
    },
    { label: "Scan again", shortcut: "r", run: requestRescan, disabled: !hasScan },
    {
      label: "Edit cleanup patterns",
      shortcut: "p",
      // The pattern list lives on the folder screen. Opening it from the
      // projects view has to switch, or the keys edit a pane that is not there.
      run: openPatternsView,
      disabled: false,
    },
    {
      label: `Sort by ${state.sortBy === "size" ? "name" : state.sortBy === "name" ? "oldest first" : "largest first"}`,
      shortcut: "o",
      run: () => mutate(toggleSortBy),
      disabled: false,
    },
    {
      label: `Use ${cycleThemeMode(state.themeMode)} theme`,
      shortcut: "t",
      run: () => mutate((s) => setThemeMode(s, cycleThemeMode(s.themeMode))),
      disabled: false,
    },
    {
      label: `Activity animation: ${motionEnabled ? "on" : "paused"}`,
      shortcut: "m",
      run: toggleMotion,
      disabled: false,
    },
    { label: "Help and shortcuts", shortcut: "?", run: () => setShowHelp(true), disabled: false },
    {
      label: "Filter by risk, kind, size or age",
      shortcut: "f",
      run: () => setFilterPicker(true),
      disabled: false,
    },
  ];
}
