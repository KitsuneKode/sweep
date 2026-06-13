import type { ScanPlan } from "@kitsunekode/sweep-protocol";

export const FIXTURE_ROOT_PLACEHOLDER = "__FIXTURE_ROOT__";

function sortCandidates(plan: ScanPlan): ScanPlan {
  const candidates = [...plan.candidates].sort((a, b) => a.path.localeCompare(b.path));
  const selectedSet = new Set(plan.selectedCandidateIds);
  const selectedCandidateIds = candidates
    .filter((candidate) => selectedSet.has(candidate.id))
    .map((candidate) => candidate.id);

  return { ...plan, candidates, selectedCandidateIds };
}

/** Normalize volatile plan fields for golden fixture comparison. */
export function normalizePlan(plan: ScanPlan, fixtureRoot: string): ScanPlan {
  const replaceRoot = (value: string) =>
    value.startsWith(fixtureRoot) ? value.replace(fixtureRoot, FIXTURE_ROOT_PLACEHOLDER) : value;

  return sortCandidates({
    ...plan,
    targetDir: FIXTURE_ROOT_PLACEHOLDER,
    createdAt: "1970-01-01T00:00:00.000Z",
    candidates: plan.candidates.map((candidate) => ({
      ...candidate,
      path: replaceRoot(candidate.path),
      estimatedBytes: 0,
    })),
    summary: {
      ...plan.summary,
      estimatedTotalBytes: 0,
    },
  });
}
