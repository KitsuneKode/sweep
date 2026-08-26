import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { groupCandidatesByScope } from "../grouping.js";
import type { SweepUiState } from "./store.js";

const visibleCache = new WeakMap<SweepUiState, ScanCandidate[]>();

export function invalidateSelectorCache(): void {
  // WeakMap caches are keyed by immutable state objects; this remains for API compatibility.
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
  const cached = visibleCache.get(state);
  if (cached) return cached;

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

  visibleCache.set(state, result);
  return result;
}
