import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { compileFilter } from "../filter-query.js";
import { artifactScopeKey, candidateMatchesScope } from "../scope-tree.js";
import type { SweepUiState } from "./store.js";

const visibleCache = new WeakMap<SweepUiState, ScanCandidate[]>();

export function invalidateSelectorCache(): void {
  // WeakMap caches are keyed by immutable state objects; this remains for API compatibility.
}

function filterCandidates(state: SweepUiState): ScanCandidate[] {
  const matches = compileFilter(state.filter);
  if (!matches) return state.candidates;
  const context = { selectedIds: state.selectedIds, now: Date.now() };
  return state.candidates.filter((candidate) => matches(candidate, context));
}

export function getVisibleCandidates(state: SweepUiState): ScanCandidate[] {
  const cached = visibleCache.get(state);
  if (cached) return cached;

  let result = filterCandidates(state);

  if (state.scopeFilter !== null) {
    result = result.filter((candidate) =>
      candidateMatchesScope(artifactScopeKey(state.targetDir, candidate.path), state.scopeFilter),
    );
  }

  if (state.riskFilter !== "all") {
    result = result.filter((candidate) => candidate.riskTier === state.riskFilter);
  }

  visibleCache.set(state, result);
  return result;
}
