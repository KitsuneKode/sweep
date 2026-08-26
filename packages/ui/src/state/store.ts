import type { RiskTier, ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { DEFAULT_PATTERNS } from "@kitsunekode/sweep-core/config";
import {
  buildScopeSidebarRows,
  scopeFilterToSidebarIndex,
  sidebarIndexToScopeFilter,
} from "../sidebar.js";
import {
  buildDisplayRows,
  firstItemRowIndex,
  moveItemRowIndex,
  rowCandidateId,
  snapRowIndexToItem,
} from "../rows.js";
import type { ThemeMode } from "../theme.js";
import { getVisibleCandidates, invalidateSelectorCache } from "./selectors.js";

export type UiFocus = "search" | "sidebar" | "list" | "patterns";

export type UiSortBy = "size" | "name";

export interface SweepUiState {
  targetDir: string;
  candidates: ScanCandidate[];
  catalogPatterns: string[];
  disabledPatterns: Set<string>;
  extraPatterns: string[];
  filter: string;
  scopeFilter: string | null;
  riskFilter: RiskTier | "all";
  rowIndex: number;
  sidebarIndex: number;
  selectedIds: Set<string>;
  focus: UiFocus;
  themeMode: ThemeMode;
  patternsDirty: boolean;
  /** True while a streaming scan is still filling candidates. */
  scanning: boolean;
  /** Artifact ordering inside groups. */
  sortBy: UiSortBy;
  /** Scope groups hidden in the artifact list (key "" = project root). */
  collapsedGroups: Set<string>;
}

export interface SweepUiSummary {
  visibleCount: number;
  selectedCount: number;
  selectedBytes: number;
  dangerousVisibleCount: number;
}

export interface SweepUiInitOptions {
  catalogPatterns?: string[];
  disabledPatterns?: string[];
  extraPatterns?: string[];
}

export function createUiState(plan: ScanPlan, init: SweepUiInitOptions = {}): SweepUiState {
  const selectedIds = new Set(plan.selectedCandidateIds);
  const candidates = plan.candidates.slice();
  const state: SweepUiState = {
    targetDir: plan.targetDir,
    candidates,
    catalogPatterns: init.catalogPatterns ?? [...DEFAULT_PATTERNS],
    disabledPatterns: new Set(init.disabledPatterns ?? []),
    extraPatterns: init.extraPatterns ?? [],
    filter: "",
    scopeFilter: null,
    riskFilter: "all",
    rowIndex: 0,
    sidebarIndex: 0,
    selectedIds,
    focus: "list",
    themeMode: "auto",
    patternsDirty: false,
    scanning: false,
    sortBy: "size",
    collapsedGroups: new Set<string>(),
  };

  const rows = buildDisplayRows(state);
  return {
    ...state,
    rowIndex: snapRowIndexToItem(rows, firstItemRowIndex(rows)),
  };
}

export function activePatterns(state: SweepUiState): string[] {
  const enabled = state.catalogPatterns.filter((pattern) => !state.disabledPatterns.has(pattern));
  return [...new Set([...enabled, ...state.extraPatterns])];
}

export function setFilter(state: SweepUiState, filter: string): SweepUiState {
  invalidateSelectorCache();
  const next: SweepUiState = { ...state, filter };
  const rows = buildDisplayRows(next);
  return {
    ...next,
    rowIndex: snapRowIndexToItem(rows, firstItemRowIndex(rows)),
  };
}

export function setScopeFilter(state: SweepUiState, scopeFilter: string | null): SweepUiState {
  invalidateSelectorCache();
  const sidebarRows = buildScopeSidebarRows(state.targetDir, state.candidates, state.selectedIds);
  const next: SweepUiState = {
    ...state,
    scopeFilter,
    sidebarIndex: scopeFilterToSidebarIndex(scopeFilter, sidebarRows),
  };
  const rows = buildDisplayRows(next);
  return {
    ...next,
    rowIndex: snapRowIndexToItem(rows, firstItemRowIndex(rows)),
  };
}

export function setRiskFilter(state: SweepUiState, riskFilter: RiskTier | "all"): SweepUiState {
  invalidateSelectorCache();
  const next: SweepUiState = { ...state, riskFilter };
  const rows = buildDisplayRows(next);
  return {
    ...next,
    rowIndex: snapRowIndexToItem(rows, firstItemRowIndex(rows)),
  };
}

export function togglePattern(state: SweepUiState, pattern: string): SweepUiState {
  const disabledPatterns = new Set(state.disabledPatterns);
  if (disabledPatterns.has(pattern)) {
    disabledPatterns.delete(pattern);
  } else {
    disabledPatterns.add(pattern);
  }
  return {
    ...state,
    disabledPatterns,
    patternsDirty: true,
    focus: "patterns",
  };
}

export function setFocus(state: SweepUiState, focus: UiFocus): SweepUiState {
  if (focus !== "sidebar") {
    return { ...state, focus };
  }

  const sidebarRows = buildScopeSidebarRows(state.targetDir, state.candidates, state.selectedIds);
  return {
    ...state,
    focus,
    sidebarIndex: scopeFilterToSidebarIndex(state.scopeFilter, sidebarRows),
  };
}

export function moveSidebarCursor(state: SweepUiState, delta: number): SweepUiState {
  const sidebarRows = buildScopeSidebarRows(state.targetDir, state.candidates, state.selectedIds);
  if (sidebarRows.length === 0) return state;

  const nextIndex = clamp(state.sidebarIndex + delta, 0, sidebarRows.length - 1);
  return { ...state, sidebarIndex: nextIndex };
}

export function applySidebarScope(state: SweepUiState): SweepUiState {
  const sidebarRows = buildScopeSidebarRows(state.targetDir, state.candidates, state.selectedIds);
  const scopeFilter = sidebarIndexToScopeFilter(state.sidebarIndex, sidebarRows);
  return setScopeFilter({ ...state, focus: "list" }, scopeFilter);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function setThemeMode(state: SweepUiState, themeMode: ThemeMode): SweepUiState {
  return { ...state, themeMode };
}

/** Merge streaming candidates by id (sized re-upserts replace discovery stubs). */
export function upsertCandidates(state: SweepUiState, incoming: ScanCandidate[]): SweepUiState {
  if (incoming.length === 0) return state;
  invalidateSelectorCache();

  const anchoredId = getCurrentCandidate(state)?.id;
  const byId = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));
  for (const candidate of incoming) {
    const existing = byId.get(candidate.id);
    // Never let a sized update clobber a user selection decision — ids are
    // deterministic so sized entries arrive with identical fields except bytes.
    byId.set(candidate.id, existing ? { ...existing, ...candidate } : candidate);
  }

  return reanchor({ ...state, candidates: [...byId.values()] }, undefined, anchoredId);
}

/** Re-run display rows and keep the cursor on `anchoredId` (or nearest item). */
function reanchor(
  state: SweepUiState,
  overrides?: Partial<SweepUiState>,
  anchoredId?: string,
): SweepUiState {
  const next = { ...state, ...overrides };
  const rows = buildDisplayRows(next);
  const id = anchoredId ?? getCurrentCandidate(state)?.id;
  const index = id ? rows.findIndex((row) => row.kind === "item" && row.candidateId === id) : -1;

  return {
    ...next,
    rowIndex: index >= 0 ? index : snapRowIndexToItem(rows, firstItemRowIndex(rows)),
  };
}

/** After structural changes, snap the cursor to the closest surviving item row. */
function snapToNearestItem(state: SweepUiState): SweepUiState {
  const rows = buildDisplayRows(state);
  return { ...state, rowIndex: snapRowIndexToItem(rows, state.rowIndex) };
}

export function setScanning(state: SweepUiState, scanning: boolean): SweepUiState {
  if (state.scanning === scanning) return state;
  return { ...state, scanning };
}

export function toggleSortBy(state: SweepUiState): SweepUiState {
  invalidateSelectorCache();
  const sortBy: UiSortBy = state.sortBy === "size" ? "name" : "size";
  return reanchor(state, { ...state, sortBy });
}

/** Collapse or expand one scope group in the artifact list. */
export function toggleGroup(state: SweepUiState, groupKey: string): SweepUiState {
  const collapsedGroups = new Set(state.collapsedGroups);
  if (collapsedGroups.has(groupKey)) {
    collapsedGroups.delete(groupKey);
  } else {
    collapsedGroups.add(groupKey);
  }
  invalidateSelectorCache();
  // Collapsing may remove the focused row; re-anchor to a visible item.
  return snapToNearestItem({ ...state, collapsedGroups });
}

/** Expand every scope group. */
export function expandAllGroups(state: SweepUiState): SweepUiState {
  if (state.collapsedGroups.size === 0) return state;
  invalidateSelectorCache();
  return snapToNearestItem({ ...state, collapsedGroups: new Set<string>() });
}

/**
 * One step of the esc ladder — walk backwards through UI state instead of
 * quitting. Returns null when there is nothing left to unwind.
 */
export function escapeStep(state: SweepUiState): SweepUiState | null {
  if (state.focus === "patterns") {
    return setFocus(state, "list");
  }
  if (state.focus === "sidebar") {
    return setFocus(state, "list");
  }
  if (state.focus === "search") {
    return setFocus(state, "list");
  }

  // List focus — peel off view narrowing one layer at a time.
  if (state.riskFilter !== "all") {
    return setRiskFilter(state, "all");
  }
  if (state.scopeFilter !== null) {
    return setScopeFilter(state, null);
  }
  if (state.filter.length > 0) {
    return setFilter(state, "");
  }
  if (state.collapsedGroups.size > 0) {
    return expandAllGroups(state);
  }

  return null;
}

/**
 * Begin a fresh scan generation: drop discovered artifacts and selections,
 * keep user view/config preferences (theme, patterns editor state, filters).
 */
export function resetForRescan(state: SweepUiState): SweepUiState {
  invalidateSelectorCache();
  return {
    ...state,
    candidates: [],
    selectedIds: new Set<string>(),
    rowIndex: 0,
    sidebarIndex: 0,
    scopeFilter: null,
    collapsedGroups: new Set<string>(),
    scanning: true,
  };
}

export function moveCursor(state: SweepUiState, delta: number): SweepUiState {
  const rows = buildDisplayRows(state);
  if (rows.length === 0) return state;

  return {
    ...state,
    rowIndex: moveItemRowIndex(rows, state.rowIndex, delta),
  };
}

export function setRowIndex(state: SweepUiState, rowIndex: number): SweepUiState {
  const rows = buildDisplayRows(state);
  if (rows.length === 0) return state;

  return {
    ...state,
    rowIndex: snapRowIndexToItem(rows, rowIndex),
  };
}

export function toggleCurrentSelection(state: SweepUiState): SweepUiState {
  const candidate = getCurrentCandidate(state);
  if (!candidate) return state;
  return toggleSelectionById(state, candidate.id);
}

export function toggleSelectionById(state: SweepUiState, candidateId: string): SweepUiState {
  const candidate = state.candidates.find((entry) => entry.id === candidateId);
  if (!candidate) return state;
  // Blocked items are hard-locked everywhere. Dangerous items CAN be selected,
  // but only deliberately (one at a time) and always behind the red confirm.
  if (candidate.riskTier === "blocked") {
    return state;
  }

  const selectedIds = new Set(state.selectedIds);
  if (selectedIds.has(candidate.id)) {
    selectedIds.delete(candidate.id);
  } else {
    selectedIds.add(candidate.id);
  }

  return { ...state, selectedIds };
}

export function countSelectedDangerous(state: SweepUiState): number {
  let count = 0;
  for (const candidate of state.candidates) {
    if (state.selectedIds.has(candidate.id) && candidate.riskTier === "dangerous") {
      count += 1;
    }
  }
  return count;
}

export function selectVisible(state: SweepUiState, includeDangerous: boolean): SweepUiState {
  const selectedIds = new Set(state.selectedIds);
  for (const candidate of getVisibleCandidates(state)) {
    if (candidate.riskTier === "blocked") continue;
    if (candidate.riskTier === "dangerous" && !includeDangerous) continue;
    selectedIds.add(candidate.id);
  }

  return { ...state, selectedIds };
}

export function clearSelection(state: SweepUiState): SweepUiState {
  return { ...state, selectedIds: new Set<string>() };
}

export function getCurrentCandidate(state: SweepUiState): ScanCandidate | undefined {
  const rows = buildDisplayRows(state);
  const candidateId = rowCandidateId(rows, state.rowIndex);
  return candidateId
    ? state.candidates.find((candidate) => candidate.id === candidateId)
    : undefined;
}

export function getUiSummary(state: SweepUiState): SweepUiSummary {
  const visible = getVisibleCandidates(state);
  let selectedCount = 0;
  let selectedBytes = 0;
  let dangerousVisibleCount = 0;

  for (const candidate of visible) {
    if (state.selectedIds.has(candidate.id)) {
      selectedCount++;
      selectedBytes += candidate.estimatedBytes;
    }

    if (candidate.riskTier === "dangerous") {
      dangerousVisibleCount++;
    }
  }

  return {
    visibleCount: visible.length,
    selectedCount,
    selectedBytes,
    dangerousVisibleCount,
  };
}

export function applyUiSelection(plan: ScanPlan, state: SweepUiState): ScanPlan {
  const selectedCandidateIds = [...state.selectedIds].filter((id) => {
    const candidate = state.candidates.find((entry) => entry.id === id);
    return candidate !== undefined && candidate.riskTier !== "blocked";
  });

  return {
    ...plan,
    candidates: state.candidates.slice(),
    selectedCandidateIds,
    summary: {
      ...plan.summary,
      candidateCount: state.candidates.length,
      selectedCount: selectedCandidateIds.length,
    },
  };
}

export function rescanConfigFromState(state: SweepUiState): {
  disabledPatterns: string[];
  extraPatterns: string[];
} {
  return {
    disabledPatterns: [...state.disabledPatterns],
    extraPatterns: [...state.extraPatterns],
  };
}
