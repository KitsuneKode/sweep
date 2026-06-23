import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { groupCandidatesByScope, type ArtifactScopeGroup } from "./grouping.js";

export interface ScopeSidebarRow {
  /** `null` means all scopes. */
  key: string | null;
  label: string;
  count: number;
  selectedCount: number;
}

export function buildScopeSidebarRows(
  targetDir: string,
  candidates: ScanCandidate[],
  selectedIds: Set<string>,
): ScopeSidebarRow[] {
  const groups = groupCandidatesByScope(targetDir, candidates);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  const allRow: ScopeSidebarRow = {
    key: null,
    label: "all scopes",
    count: candidates.length,
    selectedCount: candidates.filter((candidate) => selectedIds.has(candidate.id)).length,
  };

  const scopeRows = groups.map((group) => scopeGroupToRow(group, byId, selectedIds));
  return [allRow, ...scopeRows];
}

function scopeGroupToRow(
  group: ArtifactScopeGroup,
  byId: Map<string, ScanCandidate>,
  selectedIds: Set<string>,
): ScopeSidebarRow {
  const groupCandidates = group.candidateIds
    .map((id) => byId.get(id))
    .filter((candidate): candidate is ScanCandidate => candidate !== undefined);

  return {
    key: group.key,
    label: group.label,
    count: groupCandidates.length,
    selectedCount: groupCandidates.filter((candidate) => selectedIds.has(candidate.id)).length,
  };
}

export function scopeFilterToSidebarIndex(
  scopeFilter: string | null,
  rows: readonly ScopeSidebarRow[],
): number {
  if (scopeFilter === null) return 0;
  const index = rows.findIndex((row) => row.key === scopeFilter);
  return index >= 0 ? index : 0;
}

export function sidebarIndexToScopeFilter(
  index: number,
  rows: readonly ScopeSidebarRow[],
): string | null {
  return rows[index]?.key ?? null;
}

export function sidebarCountWidth(rows: readonly ScopeSidebarRow[]): number {
  return Math.max(1, ...rows.map((row) => String(row.count).length));
}
