import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { compileFilter } from "../filter-query.js";
import { artifactScopeKey, candidateMatchesScope } from "../scope-tree.js";
import type { SweepUiState } from "./store.js";

/**
 * Selector results are pure functions of a small input tuple - candidates,
 * filters, selection - but state objects are rebuilt on every dispatch, so a
 * WeakMap on `state` misses on every keystroke. Key the cache on the input
 * tuple instead: cursor moves, notices and focus changes all hit.
 *
 * `older:`/`newer:` filters read `now` - the tuple carries it quantized to
 * the minute so age filters stay honest without forfeiting the cache.
 */
interface VisibleInputs {
  candidates: ScanCandidate[];
  filter: string;
  scopeFilter: string | null;
  riskFilter: SweepUiState["riskFilter"];
  selectedIds: ReadonlySet<string>;
  targetDir: string;
  nowMinute: number;
}

let visibleLast: { inputs: VisibleInputs; result: ScanCandidate[] } | null = null;

function visibleInputsOf(state: SweepUiState): VisibleInputs {
  return {
    candidates: state.candidates,
    filter: state.filter,
    scopeFilter: state.scopeFilter,
    riskFilter: state.riskFilter,
    selectedIds: state.selectedIds,
    targetDir: state.targetDir,
    nowMinute: Math.floor(Date.now() / 60_000),
  };
}

function sameVisibleInputs(a: VisibleInputs, b: VisibleInputs): boolean {
  return (
    a.candidates === b.candidates &&
    (!/(?:^|\s)!?is:(?:queued|unqueued)(?:\s|$)/i.test(a.filter) ||
      a.selectedIds === b.selectedIds) &&
    a.filter === b.filter &&
    a.scopeFilter === b.scopeFilter &&
    a.riskFilter === b.riskFilter &&
    a.targetDir === b.targetDir &&
    a.nowMinute === b.nowMinute
  );
}

export function invalidateSelectorCache(): void {
  visibleLast = null;
}

function filterCandidates(state: SweepUiState, now: number): ScanCandidate[] {
  const matches = compileFilter(state.filter);
  if (!matches) return state.candidates;
  const context = { selectedIds: state.selectedIds, now };
  return state.candidates.filter((candidate) => matches(candidate, context));
}

export function getVisibleCandidates(state: SweepUiState): ScanCandidate[] {
  const inputs = visibleInputsOf(state);
  if (visibleLast && sameVisibleInputs(visibleLast.inputs, inputs)) {
    return visibleLast.result;
  }

  let result = filterCandidates(state, inputs.nowMinute * 60_000);

  if (state.scopeFilter !== null) {
    result = result.filter((candidate) =>
      candidateMatchesScope(artifactScopeKey(state.targetDir, candidate.path), state.scopeFilter),
    );
  }

  if (state.riskFilter !== "all") {
    result = result.filter((candidate) => candidate.riskTier === state.riskFilter);
  }

  visibleLast = { inputs, result };
  return result;
}
