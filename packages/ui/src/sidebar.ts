import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { buildScopeTreeRows, type ScopeSidebarRow } from "./scope-tree.js";
import { cellWidth } from "./text-cells.js";

export type { ScopeSidebarRow } from "./scope-tree.js";

export function buildScopeSidebarRows(
  targetDir: string,
  candidates: ScanCandidate[],
  selectedIds: Set<string>,
  expandedKeys: ReadonlySet<string> = new Set(),
): ScopeSidebarRow[] {
  return buildScopeTreeRows(targetDir, candidates, selectedIds, expandedKeys);
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

// Folded rather than spread into `Math.max(...rows)`, which passes one argument
// per row and has a hard engine limit (~500k in Bun). A sidebar that deep is not
// reachable today; a fold has no downside, so there is no reason to sit near it.
export function sidebarCountWidth(rows: readonly ScopeSidebarRow[]): number {
  return rows.reduce(
    (widest, row) => Math.max(widest, sidebarItemCount(row.count, row.selectedCount).length),
    1,
  );
}

export function sidebarItemCount(count: number, selectedCount: number): string {
  return selectedCount > 0 && selectedCount < count ? `${selectedCount}/${count}` : String(count);
}

export function sidebarBytesWidth(rows: readonly ScopeSidebarRow[]): number {
  return rows.reduce((widest, row) => Math.max(widest, compactBytesLabel(row.bytes).length), 6);
}

/**
 * Fit a scope row to the pane. Size is the column that matters, so the item
 * count goes first, then the bytes, and only then does the label shrink.
 */
export function sidebarColumnLayout(
  paneWidth: number,
  countWidth: number,
  bytesWidth: number,
  depth = 0,
): {
  maxLabelWidth: number;
  showBytes: boolean;
  countWidth: number;
  bytesWidth: number;
  barWidth: number;
} {
  const indent = Math.max(0, depth) * 2;
  // Disclosure marker, its space and two cells of wrap safety.
  const base = paneWidth - indent - 4;
  const minLabel = 10;
  let showCount = true;
  let showBytes = paneWidth >= 22;
  const label = () => base - (showCount ? countWidth + 2 : 0) - (showBytes ? bytesWidth + 2 : 0);
  if (label() < minLabel) showCount = false;
  if (label() < 8 && showBytes) {
    showBytes = false;
    showCount = true;
    if (label() < minLabel) showCount = false;
  }
  // The share bar is a luxury: it only takes cells a full label does not need.
  const barWidth = showBytes && label() >= 22 ? 4 : 0;
  return {
    maxLabelWidth: Math.max(1, label() - (barWidth > 0 ? barWidth + 1 : 0)),
    showBytes,
    countWidth: showCount ? countWidth : 0,
    bytesWidth: showBytes ? bytesWidth : 0,
    barWidth,
  };
}

/** Compact byte label for dense sidebar columns (e.g. `1.2GiB`, `400MiB`). */
export function compactBytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes <= 0) return "0B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${units[unit]}`;
}

/**
 * The longest footer hint that fits whole. A hint cut mid-word ("○ que")
 * reads worse than a shorter complete one, so wording drops before clipping.
 */
export function sidebarHint(focused: boolean, width: number): string {
  const options = focused
    ? ["Enter browse · space queue", "space queue", "space"]
    : ["Names browse · ○ queues", "○ queues", "○"];
  return options.find((hint) => cellWidth(hint) <= width) ?? "";
}
