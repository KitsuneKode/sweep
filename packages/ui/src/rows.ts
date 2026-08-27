import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { groupCandidatesByScope } from "./grouping.js";
import type { SweepUiState, UiSortBy } from "./state.js";
import { getVisibleCandidates } from "./state.js";

export type UiDisplayRow =
  | {
      kind: "header";
      groupKey: string;
      label: string;
      itemCount: number;
      selectedCount: number;
      collapsed: boolean;
      bytes: number;
    }
  | {
      kind: "item";
      candidateId: string;
    };

function itemComparator(sortBy: UiSortBy): (a: ScanCandidate, b: ScanCandidate) => number {
  if (sortBy === "name") {
    return (a, b) => a.name.localeCompare(b.name);
  }
  // Largest first — ncdu-style triage order; ties break alphabetically.
  return (a, b) => b.estimatedBytes - a.estimatedBytes || a.name.localeCompare(b.name);
}

const displayRowsCache = new WeakMap<SweepUiState, UiDisplayRow[]>();

export function buildDisplayRows(state: SweepUiState): UiDisplayRow[] {
  const cached = displayRowsCache.get(state);
  if (cached) return cached;
  const rows = computeDisplayRows(state);
  displayRowsCache.set(state, rows);
  return rows;
}

/**
 * Discovery position per candidate.
 *
 * `state.candidates` is insertion-ordered: `upsertCandidates` merges through a
 * Map, and re-setting an existing key keeps its original slot, so a sized
 * update never moves a candidate. That makes array position a stable identity
 * for "when did we first see this".
 */
function discoveryIndex(state: SweepUiState): Map<string, number> {
  const index = new Map<string, number>();
  for (const [position, candidate] of state.candidates.entries()) {
    index.set(candidate.id, position);
  }
  return index;
}

/** Earliest discovery position in a group — where the group sorts while pinned. */
function firstDiscovery(group: { candidateIds: string[] }, order: Map<string, number>): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const id of group.candidateIds) {
    earliest = Math.min(earliest, order.get(id) ?? Number.POSITIVE_INFINITY);
  }
  return earliest;
}

function computeDisplayRows(state: SweepUiState): UiDisplayRow[] {
  const visible = getVisibleCandidates(state);
  const byId = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));

  // Pinned (live scan): order by discovery so sizes landing mid-scan cannot
  // reshuffle the list under the cursor. Unpinned: the real triage order.
  const order = state.orderPinned ? discoveryIndex(state) : null;
  const compare = order
    ? (left: ScanCandidate, right: ScanCandidate) =>
        (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0)
    : itemComparator(state.sortBy);

  const groups = groupCandidatesByScope(state.targetDir, visible, compare, {
    maxGroups: Number.POSITIVE_INFINITY,
  });
  const rows: UiDisplayRow[] = [];

  if (order) {
    // A newly discovered scope lands at the bottom rather than pushing the
    // list around; existing scopes keep their place for the whole scan.
    groups.sort((left, right) => firstDiscovery(left, order) - firstDiscovery(right, order));
  } else if (state.sortBy === "size") {
    // Heaviest scope first so the top of the list is the biggest win.
    groups.sort((left, right) => groupBytes(right, byId) - groupBytes(left, byId));
  }

  for (const group of groups) {
    const groupCandidates = group.candidateIds
      .map((id) => byId.get(id))
      .filter((candidate): candidate is ScanCandidate => candidate !== undefined);

    const selectedCount = groupCandidates.filter((candidate) =>
      state.selectedIds.has(candidate.id),
    ).length;

    const collapsed = state.collapsedGroups.has(group.key);
    const bytes = groupCandidates.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0);
    // Trees flattenEmptyDirectories / CommandItem: a lone artifact already
    // carries its parent in the name column, so a heading is just chrome.
    // While pinned the heading is always drawn — otherwise a group's second
    // artifact makes one appear above the cursor and shifts the rows below it.
    const showHeader = order !== null || groupCandidates.length !== 1 || collapsed;

    if (showHeader) {
      rows.push({
        kind: "header",
        groupKey: group.key,
        label: group.label,
        itemCount: groupCandidates.length,
        selectedCount,
        collapsed,
        bytes,
      });
    }

    if (collapsed) continue;

    for (const candidate of groupCandidates) {
      rows.push({ kind: "item", candidateId: candidate.id });
    }
  }

  return rows;
}

function groupBytes(group: { candidateIds: string[] }, byId: Map<string, ScanCandidate>): number {
  let total = 0;
  for (const id of group.candidateIds) {
    total += byId.get(id)?.estimatedBytes ?? 0;
  }
  return total;
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

/**
 * Move the cursor by `delta` *item* rows, stepping over group headings.
 *
 * cmdk / shadcn Command never parks the cursor on a heading: arrow keys walk
 * selectable items only, so the detail line and `space` always have a subject.
 * Headers are still collapsible from the keyboard via h/l.
 */
export function moveItemRowIndex(rows: UiDisplayRow[], rowIndex: number, delta: number): number {
  if (rows.length === 0) return 0;

  const step = delta === 0 ? 0 : delta > 0 ? 1 : -1;
  if (step === 0) return snapRowIndexToItem(rows, rowIndex);

  let index = rowIndex;
  let remaining = Math.abs(delta);
  let lastItem = rows[index]?.kind === "item" ? index : -1;

  while (remaining > 0) {
    const next = index + step;
    if (next < 0 || next >= rows.length) break;
    index = next;
    if (rows[index]?.kind === "item") {
      lastItem = index;
      remaining -= 1;
    }
  }

  // Ran off the end mid-page: settle on the furthest item we actually reached.
  if (lastItem >= 0) return lastItem;
  return snapRowIndexToItem(rows, clamp(rowIndex + delta, 0, rows.length - 1));
}

/** First selectable item row, or 0 when the list holds no items. */
export function firstSelectableRow(rows: UiDisplayRow[]): number {
  const index = rows.findIndex((row) => row.kind === "item");
  return index >= 0 ? index : 0;
}

/** Last selectable item row, or 0 when the list holds no items. */
export function lastSelectableRow(rows: UiDisplayRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.kind === "item") return i;
  }
  return 0;
}

/** Index of the header that owns `rowIndex`, or -1 at the top level. */
export function owningHeaderIndex(rows: UiDisplayRow[], rowIndex: number): number {
  for (let i = Math.min(rowIndex, rows.length - 1); i >= 0; i--) {
    if (rows[i]?.kind === "header") return i;
  }
  return -1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function rowCandidateId(rows: UiDisplayRow[], rowIndex: number): string | undefined {
  const row = rows[rowIndex];
  return row?.kind === "item" ? row.candidateId : undefined;
}
