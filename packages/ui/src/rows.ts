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
      /**
       * Label of the owning group header - item rows suppress the per-item
       * parent path when it would just repeat this.
       */
      groupLabel: string;
    };

function itemComparator(sortBy: UiSortBy): (a: ScanCandidate, b: ScanCandidate) => number {
  if (sortBy === "name") {
    return (a, b) => a.name.localeCompare(b.name);
  }
  if (sortBy === "age") {
    // Stalest first: the oldest artifacts are the safest wins. Unknown mtimes
    // sink to the bottom rather than posing as ancient.
    return (a, b) =>
      (a.modifiedMs ?? Number.POSITIVE_INFINITY) - (b.modifiedMs ?? Number.POSITIVE_INFINITY) ||
      b.estimatedBytes - a.estimatedBytes ||
      a.name.localeCompare(b.name);
  }
  // Largest first - ncdu-style triage order; ties break alphabetically.
  return (a, b) => b.estimatedBytes - a.estimatedBytes || a.name.localeCompare(b.name);
}

/**
 * Display rows depend on a fixed input tuple - the visible candidates plus
 * sort/pin/collapse - but every dispatch produces a new state object, so a
 * WeakMap keyed on `state` misses on every keystroke. Key on the tuple
 * instead; the visible-candidate list is itself memoized upstream, so
 * identical inputs mean identical rows.
 */
interface RowsInputs {
  candidates: ScanCandidate[];
  filter: string;
  scopeFilter: string | null;
  riskFilter: SweepUiState["riskFilter"];
  selectedIds: ReadonlySet<string>;
  collapsedGroups: ReadonlySet<string>;
  sortBy: UiSortBy;
  orderPinned: boolean;
  targetDir: string;
  nowMinute: number;
}

let rowsLast: { inputs: RowsInputs; visible: ScanCandidate[]; result: UiDisplayRow[] } | null =
  null;
let groupMembers = new Map<string, string[]>();

export function buildDisplayRows(state: SweepUiState): UiDisplayRow[] {
  const inputs: RowsInputs = {
    candidates: state.candidates,
    filter: state.filter,
    scopeFilter: state.scopeFilter,
    riskFilter: state.riskFilter,
    selectedIds: state.selectedIds,
    collapsedGroups: state.collapsedGroups,
    sortBy: state.sortBy,
    orderPinned: state.orderPinned,
    targetDir: state.targetDir,
    nowMinute: Math.floor(Date.now() / 60_000),
  };
  const visible = getVisibleCandidates(state);
  const last = rowsLast;
  if (
    last &&
    last.inputs.candidates === inputs.candidates &&
    last.visible === visible &&
    last.inputs.collapsedGroups === inputs.collapsedGroups &&
    last.inputs.filter === inputs.filter &&
    last.inputs.scopeFilter === inputs.scopeFilter &&
    last.inputs.riskFilter === inputs.riskFilter &&
    last.inputs.sortBy === inputs.sortBy &&
    last.inputs.orderPinned === inputs.orderPinned &&
    last.inputs.targetDir === inputs.targetDir &&
    last.inputs.nowMinute === inputs.nowMinute
  ) {
    if (last.inputs.selectedIds === inputs.selectedIds) return last.result;
    const result = last.result.map((row) =>
      row.kind === "item"
        ? row
        : {
            ...row,
            selectedCount: (groupMembers.get(row.groupKey) ?? []).reduce(
              (n, id) => n + Number(state.selectedIds.has(id)),
              0,
            ),
          },
    );
    rowsLast = { inputs, visible, result };
    return result;
  }
  const result = computeDisplayRows(state);
  rowsLast = { inputs, visible, result };
  return result;
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

/** Earliest discovery position in a group - where the group sorts while pinned. */
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
  groupMembers = new Map(groups.map((group) => [group.key, group.candidateIds]));
  const metrics = new Map(
    groups.map((group) => [
      group.key,
      {
        bytes: groupBytes(group, byId),
        oldest: oldestModified(group, byId),
        first: order ? firstDiscovery(group, order) : 0,
      },
    ]),
  );

  if (order) {
    // A newly discovered scope lands at the bottom rather than pushing the
    // list around; existing scopes keep their place for the whole scan.
    groups.sort((left, right) => metrics.get(left.key)!.first - metrics.get(right.key)!.first);
  } else if (state.sortBy === "size") {
    // Heaviest scope first so the top of the list is the biggest win.
    groups.sort((left, right) => metrics.get(right.key)!.bytes - metrics.get(left.key)!.bytes);
  } else if (state.sortBy === "age") {
    // The scope holding the stalest artifact leads.
    groups.sort((left, right) => metrics.get(left.key)!.oldest - metrics.get(right.key)!.oldest);
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
    // Every group gets a header - even single-item ones. An orphan row under
    // the previous group's heading reads as belonging to that group, which is
    // how a root-level artifact could end up looking like it lived inside the
    // group above it. While pinned this is doubly required: without it a
    // group's second artifact would push a heading in above the cursor.
    rows.push({
      kind: "header",
      groupKey: group.key,
      label: group.label,
      itemCount: groupCandidates.length,
      selectedCount,
      collapsed,
      bytes,
    });

    if (collapsed) continue;

    for (const candidate of groupCandidates) {
      rows.push({ kind: "item", candidateId: candidate.id, groupLabel: group.label });
    }
  }

  return rows;
}

function oldestModified(
  group: { candidateIds: string[] },
  byId: Map<string, ScanCandidate>,
): number {
  let oldest = Number.POSITIVE_INFINITY;
  for (const id of group.candidateIds) {
    oldest = Math.min(oldest, byId.get(id)?.modifiedMs ?? Number.POSITIVE_INFINITY);
  }
  return oldest;
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
