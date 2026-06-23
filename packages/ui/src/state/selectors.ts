import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { groupCandidatesByScope } from "../grouping.js";
import type { SweepUiState } from "./store.js";

let cacheKey = "";
let cachedVisible: ScanCandidate[] = [];

export function invalidateSelectorCache(): void {
  cacheKey = "";
  cachedVisible = [];
}

function selectorKey(state: SweepUiState): string {
  return [
    state.filter,
    state.scopeFilter ?? "",
    state.riskFilter,
    state.candidates.map((c) => c.id).join(","),
  ].join("|");
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

export function getVisibleCandidates(state: SweepUiState): ScanCandidate[] {
  const key = selectorKey(state);
  if (key === cacheKey) {
    return cachedVisible;
  }

  let ids = new Set(filterCandidateIds(state.candidates, state.filter));

  if (state.scopeFilter !== null) {
    const groups = groupCandidatesByScope(state.targetDir, state.candidates);
    const group = groups.find((g) => g.key === state.scopeFilter);
    const scopeIds = new Set(group?.candidateIds ?? []);
    ids = new Set([...ids].filter((id) => scopeIds.has(id)));
  }

  if (state.riskFilter !== "all") {
    ids = new Set(
      state.candidates
        .filter((candidate) => ids.has(candidate.id) && candidate.riskTier === state.riskFilter)
        .map((candidate) => candidate.id),
    );
  }

  cachedVisible = state.candidates.filter((candidate) => ids.has(candidate.id));
  cacheKey = key;
  return cachedVisible;
}
