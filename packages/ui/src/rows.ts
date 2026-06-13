import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { groupCandidatesByScope } from "./grouping.js";
import type { SweepUiState } from "./state.js";
import { getVisibleCandidates } from "./state.js";

export type UiDisplayRow =
  | {
      kind: "header";
      groupKey: string;
      label: string;
      itemCount: number;
      selectedCount: number;
    }
  | {
      kind: "item";
      candidateId: string;
    };

export function buildDisplayRows(state: SweepUiState): UiDisplayRow[] {
  const visible = getVisibleCandidates(state);
  const groups = groupCandidatesByScope(state.targetDir, visible);
  const byId = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));
  const rows: UiDisplayRow[] = [];

  for (const group of groups) {
    const groupCandidates = group.candidateIds
      .map((id) => byId.get(id))
      .filter((candidate): candidate is ScanCandidate => candidate !== undefined);

    const selectedCount = groupCandidates.filter((candidate) =>
      state.selectedIds.has(candidate.id),
    ).length;

    rows.push({
      kind: "header",
      groupKey: group.key,
      label: group.label,
      itemCount: groupCandidates.length,
      selectedCount,
    });

    for (const candidate of groupCandidates) {
      rows.push({ kind: "item", candidateId: candidate.id });
    }
  }

  return rows;
}

export function firstItemRowIndex(rows: UiDisplayRow[]): number {
  return rows.findIndex((row) => row.kind === "item");
}

export function snapRowIndexToItem(rows: UiDisplayRow[], rowIndex: number): number {
  if (rows.length === 0) return 0;
  if (rows[rowIndex]?.kind === "item") return rowIndex;

  for (let offset = 0; offset < rows.length; offset++) {
    const down = rowIndex + offset;
    if (down < rows.length && rows[down]?.kind === "item") return down;

    const up = rowIndex - offset;
    if (up >= 0 && rows[up]?.kind === "item") return up;
  }

  return 0;
}

export function moveItemRowIndex(rows: UiDisplayRow[], rowIndex: number, delta: number): number {
  const itemIndices = rows.flatMap((row, index) => (row.kind === "item" ? [index] : []));
  if (itemIndices.length === 0) return 0;

  const currentIndex = snapRowIndexToItem(rows, rowIndex);
  const currentPos = Math.max(0, itemIndices.indexOf(currentIndex));
  const nextPos = clamp(currentPos + delta, 0, itemIndices.length - 1);
  return itemIndices[nextPos] ?? itemIndices[0]!;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function rowCandidateId(rows: UiDisplayRow[], rowIndex: number): string | undefined {
  const row = rows[rowIndex];
  return row?.kind === "item" ? row.candidateId : undefined;
}
