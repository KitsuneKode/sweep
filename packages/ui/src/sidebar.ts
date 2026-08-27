import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { buildScopeTreeRows, type ScopeSidebarRow } from "./scope-tree.js";

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
  return rows.reduce((widest, row) => Math.max(widest, String(row.count).length), 1);
}

export function sidebarBytesWidth(rows: readonly ScopeSidebarRow[]): number {
  return rows.reduce((widest, row) => Math.max(widest, compactBytesLabel(row.bytes).length), 6);
}

/** Drop the bytes column before the label when the pane is too narrow. */
export function sidebarColumnLayout(
  paneWidth: number,
  countWidth: number,
  bytesWidth: number,
  depth = 0,
): { maxLabelWidth: number; showBytes: boolean; countWidth: number; bytesWidth: number } {
  const indent = Math.max(0, depth) * 2;
  let showBytes = paneWidth >= 22;
  let fittedBytesWidth = showBytes ? bytesWidth : 0;
  let gaps = showBytes ? 8 : 6;
  let maxLabelWidth = paneWidth - countWidth - fittedBytesWidth - gaps - indent;
  if (maxLabelWidth < 8 && showBytes) {
    showBytes = false;
    fittedBytesWidth = 0;
    gaps = 6;
    maxLabelWidth = paneWidth - countWidth - gaps - indent;
  }
  return {
    maxLabelWidth: Math.max(6, maxLabelWidth),
    showBytes,
    countWidth,
    bytesWidth: fittedBytesWidth,
  };
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
