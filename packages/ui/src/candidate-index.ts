import type { ScanCandidate } from "@kitsunekode/sweep-protocol";

let last: { candidates: ScanCandidate[]; index: ReadonlyMap<string, ScanCandidate> } | null = null;

/** One immutable lookup per candidate-array revision, shared by the app,
 * rows, groups and reducer lookups. Historical revisions are not retained. */
export function candidateIndex(candidates: ScanCandidate[]): ReadonlyMap<string, ScanCandidate> {
  if (last?.candidates !== candidates) {
    const index = new Map<string, ScanCandidate>();
    for (const candidate of candidates) index.set(candidate.id, candidate);
    last = { candidates, index };
  }
  return last.index;
}

export function clearCandidateIndex(): void {
  last = null;
}
