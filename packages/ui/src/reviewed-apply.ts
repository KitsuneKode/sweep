import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import { planForCandidateIds, type SweepUiState } from "./state.js";

/** Own exactly the reviewed selection, including nested identity/policy data.
 * Browsing context and later caller mutations cannot widen this confirmation. */
export function captureReviewedApply(
  plan: ScanPlan,
  state: SweepUiState,
  ids: ReadonlySet<string> | readonly string[],
): ScanPlan {
  const reviewed = planForCandidateIds(plan, state, ids);
  const selected = new Set(reviewed.selectedCandidateIds);
  if (selected.size !== new Set(ids).size)
    throw new Error("Selection changed before review; review the queue again");
  const candidates = reviewed.candidates.filter((candidate) => selected.has(candidate.id));
  const riskCounts = { safe: 0, caution: 0, dangerous: 0, blocked: 0 };
  let bytes = 0;
  for (const candidate of candidates) {
    riskCounts[candidate.riskTier]++;
    bytes += candidate.estimatedBytes;
  }
  return structuredClone({
    ...reviewed,
    candidates,
    summary: {
      ...reviewed.summary,
      candidateCount: candidates.length,
      selectedCount: selected.size,
      estimatedTotalBytes: bytes,
      riskCounts,
    },
  });
}
