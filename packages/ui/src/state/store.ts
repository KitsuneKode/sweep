import type { RiskTier, ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { DEFAULT_PATTERNS } from "@kitsunekode/sweep-core/config";
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
  selectedIds: Set<string>;
  focus: UiFocus;
  themeMode: ThemeMode;
  patternsDirty: boolean;
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
    selectedIds,
    focus: "list",
    themeMode: "dark",
    patternsDirty: false,
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
  const next: SweepUiState = { ...state, scopeFilter };
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
  return { ...state, focus };
}

export function setThemeMode(state: SweepUiState, themeMode: ThemeMode): SweepUiState {
  return { ...state, themeMode };
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
  if (candidate.riskTier === "blocked") return state;

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
  return {
    ...plan,
    selectedCandidateIds: [...state.selectedIds],
    summary: {
      ...plan.summary,
      selectedCount: state.selectedIds.size,
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
