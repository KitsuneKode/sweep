import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";

export interface SweepUiState {
  candidates: ScanCandidate[];
  filter: string;
  filteredIds: string[];
  cursorIndex: number;
  selectedIds: Set<string>;
}

export interface SweepUiSummary {
  visibleCount: number;
  selectedCount: number;
  selectedBytes: number;
  dangerousVisibleCount: number;
}

export function createUiState(plan: ScanPlan): SweepUiState {
  const selectedIds = new Set(plan.selectedCandidateIds);
  const candidates = plan.candidates.slice();
  return {
    candidates,
    filter: "",
    filteredIds: filterCandidateIds(candidates, ""),
    cursorIndex: 0,
    selectedIds,
  };
}

export function setFilter(state: SweepUiState, filter: string): SweepUiState {
  const filteredIds = filterCandidateIds(state.candidates, filter);
  const nextCursorIndex = Math.min(state.cursorIndex, Math.max(filteredIds.length - 1, 0));
  return {
    ...state,
    filter,
    filteredIds,
    cursorIndex: nextCursorIndex,
  };
}

export function moveCursor(state: SweepUiState, delta: number): SweepUiState {
  if (state.filteredIds.length === 0) return state;

  const nextIndex = clamp(state.cursorIndex + delta, 0, state.filteredIds.length - 1);
  return {
    ...state,
    cursorIndex: nextIndex,
  };
}

export function toggleCurrentSelection(state: SweepUiState): SweepUiState {
  const candidate = getCurrentCandidate(state);
  if (!candidate) return state;

  const selectedIds = new Set(state.selectedIds);
  if (selectedIds.has(candidate.id)) {
    selectedIds.delete(candidate.id);
  } else {
    selectedIds.add(candidate.id);
  }

  return {
    ...state,
    selectedIds,
  };
}

export function selectVisible(state: SweepUiState, includeDangerous: boolean): SweepUiState {
  const selectedIds = new Set(state.selectedIds);
  for (const candidate of getVisibleCandidates(state)) {
    if (candidate.riskTier === "blocked") continue;
    if (candidate.riskTier === "dangerous" && !includeDangerous) continue;
    selectedIds.add(candidate.id);
  }

  return {
    ...state,
    selectedIds,
  };
}

export function clearSelection(state: SweepUiState): SweepUiState {
  return {
    ...state,
    selectedIds: new Set<string>(),
  };
}

export function getCurrentCandidate(state: SweepUiState): ScanCandidate | undefined {
  const currentId = state.filteredIds[state.cursorIndex];
  return currentId ? state.candidates.find((candidate) => candidate.id === currentId) : undefined;
}

export function getVisibleCandidates(state: SweepUiState): ScanCandidate[] {
  const visibleIds = new Set(state.filteredIds);
  return state.candidates.filter((candidate) => visibleIds.has(candidate.id));
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

function filterCandidateIds(candidates: ScanCandidate[], filter: string): string[] {
  const query = filter.trim().toLowerCase();
  if (query.length === 0) return candidates.map((candidate) => candidate.id);

  return candidates
    .filter((candidate) => {
      const haystack =
        `${candidate.name} ${candidate.path} ${candidate.kind} ${candidate.riskTier}`.toLowerCase();
      return haystack.includes(query);
    })
    .map((candidate) => candidate.id);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
