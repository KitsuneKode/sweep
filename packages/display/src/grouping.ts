import type { CandidateKind, ScanCandidate, ScanEntry } from "@kitsunekode/sweep-protocol";
import { candidateKindFromName as kindFromName } from "@kitsunekode/sweep-core/planner";

export interface ScanResultGroup {
  kind: CandidateKind;
  label: string;
  entries: ScanEntry[];
  totalBytes: number;
}

export interface CandidateGroup {
  kind: CandidateKind;
  label: string;
  entries: ScanCandidate[];
  totalBytes: number;
}

function kindLabel(kind: CandidateKind): string {
  return kind === "custom" ? "custom patterns" : kind;
}

/** Group scan entries by inferred artifact kind. */
export function groupScanEntries(entries: ScanEntry[]): ScanResultGroup[] {
  const buckets = new Map<CandidateKind, ScanEntry[]>();

  for (const entry of entries) {
    const kind = kindFromName(entry.name);
    const bucket = buckets.get(kind) ?? [];
    bucket.push(entry);
    buckets.set(kind, bucket);
  }

  return [...buckets.entries()]
    .map(([kind, groupedEntries]) => ({
      kind,
      label: kindLabel(kind),
      entries: groupedEntries,
      totalBytes: groupedEntries.reduce((sum, entry) => sum + entry.estimatedBytes, 0),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/** Group scan candidates by artifact kind. */
export function groupCandidatesByKind(candidates: ScanCandidate[]): CandidateGroup[] {
  const buckets = new Map<CandidateKind, ScanCandidate[]>();

  for (const candidate of candidates) {
    const bucket = buckets.get(candidate.kind) ?? [];
    bucket.push(candidate);
    buckets.set(candidate.kind, bucket);
  }

  return [...buckets.entries()]
    .map(([kind, groupedEntries]) => ({
      kind,
      label: kindLabel(kind),
      entries: groupedEntries,
      totalBytes: groupedEntries.reduce((sum, entry) => sum + entry.estimatedBytes, 0),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}
