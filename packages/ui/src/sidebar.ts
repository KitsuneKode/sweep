import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { groupCandidatesByScope, type ArtifactScopeGroup } from "./grouping.js";

export interface ScopeSidebarRow {
  /** `null` means all scopes. */
  key: string | null;
  label: string;
  count: number;
  selectedCount: number;
  /** Sum of estimatedBytes for candidates in this scope. */
  bytes: number;
  /** Sum of estimatedBytes for selected candidates in this scope. */
  selectedBytes: number;
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
    bytes: candidates.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
    selectedBytes: candidates
      .filter((candidate) => selectedIds.has(candidate.id))
      .reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
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

  const selected = groupCandidates.filter((candidate) => selectedIds.has(candidate.id));

  return {
    key: group.key,
    label: group.label,
    count: groupCandidates.length,
    selectedCount: selected.length,
    bytes: groupCandidates.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
    selectedBytes: selected.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
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

export function sidebarBytesWidth(rows: readonly ScopeSidebarRow[]): number {
  // Pre-format via a compact helper-free estimate: max digit width for "999.9 GB"
  return Math.max(6, ...rows.map((row) => compactBytesLabel(row.bytes).length));
}

/** Compact byte label for dense sidebar columns (e.g. `1.2GB`, `400MB`). */
export function compactBytesLabel(bytes: number): string {
  if (bytes <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${units[unit]}`;
}
