import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { relativePath } from "./presentation.js";

export interface ArtifactScopeGroup {
  /** Stable sort key — empty string means scan root. */
  key: string;
  /** Human label for the scope, e.g. `project root` or `apps/cli/`. */
  label: string;
  candidateIds: string[];
}

/** Classify artifacts by the directory they live under relative to the scan root. */
export function groupCandidatesByScope(
  targetDir: string,
  candidates: ScanCandidate[],
  compareItems?: (a: ScanCandidate, b: ScanCandidate) => number,
): ArtifactScopeGroup[] {
  const buckets = new Map<string, { label: string; ids: string[] }>();
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  for (const candidate of candidates) {
    const relative = relativePath(targetDir, candidate.path).replaceAll("\\", "/");
    const segments = relative.split("/").filter((segment) => segment.length > 0);
    const key = segments.length <= 1 ? "" : segments.slice(0, -1).join("/");
    const label = key.length === 0 ? "project root" : `${key}/`;

    const bucket = buckets.get(key) ?? { label, ids: [] };
    bucket.ids.push(candidate.id);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => compareScopeKeys(left, right))
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      candidateIds: bucket.ids.sort((leftId, rightId) => {
        if (compareItems) {
          const left = byId.get(leftId);
          const right = byId.get(rightId);
          if (left && right) return compareItems(left, right);
        }
        const leftName = byId.get(leftId)?.name ?? "";
        const rightName = byId.get(rightId)?.name ?? "";
        return leftName.localeCompare(rightName);
      }),
    }));
}

function compareScopeKeys(left: string, right: string): number {
  if (left.length === 0) return -1;
  if (right.length === 0) return 1;
  return left.localeCompare(right);
}
