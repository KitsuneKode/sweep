import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { groupCandidatesByScope } from "../grouping.js";
import type { SweepUiState } from "./store.js";

export function invalidateSelectorCache(): void {
  // Pure selectors don't rely on global mutable state; retained for API compatibility
}

function filterCandidates(candidates: ScanCandidate[], filter: string): ScanCandidate[] {
  const query = filter.trim().toLowerCase();
  if (query.length === 0) return candidates;

  return candidates.filter((candidate) => {
    const haystack =
      `${candidate.name} ${candidate.path} ${candidate.kind} ${candidate.riskTier}`.toLowerCase();
    return haystack.includes(query);
  });
}

export function getVisibleCandidates(state: SweepUiState): ScanCandidate[] {
  let result = filterCandidates(state.candidates, state.filter);

  if (state.scopeFilter !== null) {
    const groups = groupCandidatesByScope(state.targetDir, state.candidates);
    const group = groups.find((g) => g.key === state.scopeFilter);
    const scopeIds = new Set(group?.candidateIds ?? []);
    result = result.filter((candidate) => scopeIds.has(candidate.id));
  }

  if (state.riskFilter !== "all") {
    result = result.filter((candidate) => candidate.riskTier === state.riskFilter);
  }

  return result;
}
