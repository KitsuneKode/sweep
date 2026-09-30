import type { RiskTier, ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { DEFAULT_PATTERNS } from "@kitsunekode/sweep-core/config";
import {
  buildScopeSidebarRows,
  scopeFilterToSidebarIndex,
  sidebarIndexToScopeFilter,
} from "../sidebar.js";
import {
  buildDisplayRows,
  firstItemRowIndex,
  moveItemRowIndex,
  rowCandidateId,
  snapRowIndexToItem,
} from "../rows.js";
import { artifactScopeKey, candidateMatchesScope } from "../scope-tree.js";
import type { ThemeMode } from "../theme.js";
import { ancestorKeysOf } from "../tree-line.js";
import { getVisibleCandidates, invalidateSelectorCache } from "./selectors.js";

export type UiFocus = "search" | "sidebar" | "list" | "patterns";

export type UiSortBy = "size" | "name" | "age";

/** `o` walks this ring; size stays first because it is the default triage order. */
const SORT_ORDER: readonly UiSortBy[] = ["size", "name", "age"];

export interface SweepUiState {
  targetDir: string;
  candidates: ScanCandidate[];
  catalogPatterns: string[];
  disabledPatterns: Set<string>;
  extraPatterns: string[];
  filter: string;
  scopeFilter: string | null;
  riskFilter: RiskTier | "all";
  rowIndex: number;
  /**
   * Candidate the visual-mode range started on, or null outside visual mode.
   * An id rather than a row index, so sorting or streaming cannot move it.
   */
  visualAnchorId: string | null;
  sidebarIndex: number;
  /** Cursor in the pattern editor; independent of artifact `rowIndex`. */
  patternIndex: number;
  selectedIds: Set<string>;
  focus: UiFocus;
  themeMode: ThemeMode;
  patternsDirty: boolean;
  /** True while a streaming scan is still filling candidates. */
  scanning: boolean;
  /** Directories visited by the current/last scan (0 until the engine reports). */
  scannedDirs: number;
  /** Artifact ordering inside groups. */
  sortBy: UiSortBy;
  /**
   * Freeze the list in discovery order.
   *
   * Set while a live scan is streaming: sizes arrive after discovery, so
   * "largest first" would re-sort the list on every batch and move rows out
   * from under the cursor. Cleared when the scan ends - which re-sorts once,
   * authoritatively - or when the user asks for a sort themselves.
   */
  orderPinned: boolean;
  /** Scope groups hidden in the artifact list (key "" = project root). */
  /** Artifact list groups folded in the main pane. */
  collapsedGroups: Set<string>;
  /** Folder keys expanded in the scopes tree. */
  expandedScopes: Set<string>;
  /**
   * Directories the scanner could not read (permissions, vanished, cycle
   * repeats). Surfaced so a partial scan never looks complete.
   */
  skippedDirs: number;
  /**
   * Ids whose queued state the user set by hand (toggle/bulk/clear). The
   * streaming seed and the end-of-scan policy reconciliation leave these
   * alone - a user decision always outranks `selectedByDefault`.
   */
  selectionTouched: Set<string>;
}

export interface SweepUiSummary {
  visibleCount: number;
  /**
   * Size of the whole queue, not just its visible part.
   *
   * `applyUiSelection` deletes every queued id regardless of the current
   * filter or scope, so anything that warns the user - the header, the tally,
   * the confirm dialog - has to count the same way. Counting only what is on
   * screen made the confirmation understate the damage.
   */
  selectedCount: number;
  selectedBytes: number;
  /** Queued artifacts that also pass the current filter/scope. */
  visibleSelectedCount: number;
  dangerousVisibleCount: number;
}

export interface SweepUiInitOptions {
  catalogPatterns?: string[];
  disabledPatterns?: string[];
  extraPatterns?: string[];
}

export function createUiState(plan: ScanPlan, init: SweepUiInitOptions = {}): SweepUiState {
  const selectedIds = new Set(plan.selectedCandidateIds);
  const candidates = plan.candidates.slice();
  const state: SweepUiState = {
    targetDir: plan.targetDir,
    candidates,
    catalogPatterns: init.catalogPatterns ?? [...DEFAULT_PATTERNS],
    disabledPatterns: new Set(init.disabledPatterns ?? []),
    extraPatterns: init.extraPatterns ?? [],
    filter: "",
    scopeFilter: null,
    riskFilter: "all",
    rowIndex: 0,
    visualAnchorId: null,
    sidebarIndex: 0,
    patternIndex: 0,
    selectedIds,
    focus: "list",
    themeMode: "auto",
    patternsDirty: false,
    scanning: false,
    scannedDirs: plan.summary.scannedDirs,
    sortBy: "size",
    orderPinned: false,
    collapsedGroups: new Set<string>(),
    expandedScopes: new Set<string>(),
    skippedDirs: 0,
    selectionTouched: new Set<string>(),
  };

  const rows = buildDisplayRows(state);
  return {
    ...state,
    rowIndex: snapRowIndexToItem(rows, firstItemRowIndex(rows)),
  };
}

export function activePatterns(state: SweepUiState): string[] {
  const enabled = state.catalogPatterns.filter((pattern) => !state.disabledPatterns.has(pattern));
  const extras = state.extraPatterns.filter((pattern) => !state.disabledPatterns.has(pattern));
  return [...new Set([...enabled, ...extras])];
}

/**
 * Every row the patterns editor can show: built-in catalog first, then custom
 * patterns passed via --pattern/.sweeprc. Toggling works on both - a disabled
 * custom pattern sits in `disabledPatterns` like a catalog one.
 */
export function allPatterns(state: SweepUiState): string[] {
  const catalog = new Set(state.catalogPatterns);
  const extras = state.extraPatterns.filter((pattern) => !catalog.has(pattern));
  return [...state.catalogPatterns, ...extras];
}

export function isCustomPattern(state: SweepUiState, pattern: string): boolean {
  return !state.catalogPatterns.includes(pattern);
}

function sidebarRowsFor(state: SweepUiState) {
  return buildScopeSidebarRows(
    state.targetDir,
    state.candidates,
    state.selectedIds,
    state.expandedScopes,
  );
}

export function setFilter(state: SweepUiState, filter: string): SweepUiState {
  invalidateSelectorCache();
  const next: SweepUiState = { ...state, filter, visualAnchorId: null };
  const rows = buildDisplayRows(next);
  return {
    ...next,
    rowIndex: snapRowIndexToItem(rows, firstItemRowIndex(rows)),
  };
}

export function setScopeFilter(state: SweepUiState, scopeFilter: string | null): SweepUiState {
  invalidateSelectorCache();

  // Open the tree down to the chosen scope. Without this a nested selection
  // applies while its row stays hidden behind collapsed parents, so the sidebar
  // shows no sign of what the artifact list is filtered to.
  const expandedScopes = new Set(state.expandedScopes);
  for (const key of ancestorKeysOf(scopeFilter)) expandedScopes.add(key);

  const withExpansion: SweepUiState = { ...state, expandedScopes };
  const sidebarRows = sidebarRowsFor(withExpansion);
  const next: SweepUiState = {
    ...withExpansion,
    scopeFilter,
    visualAnchorId: null,
    sidebarIndex: scopeFilterToSidebarIndex(scopeFilter, sidebarRows),
  };
  const rows = buildDisplayRows(next);
  return {
    ...next,
    rowIndex: snapRowIndexToItem(rows, firstItemRowIndex(rows)),
  };
}

export function setRiskFilter(state: SweepUiState, riskFilter: RiskTier | "all"): SweepUiState {
  invalidateSelectorCache();
  const next: SweepUiState = { ...state, riskFilter, visualAnchorId: null };
  const rows = buildDisplayRows(next);
  return {
    ...next,
    rowIndex: snapRowIndexToItem(rows, firstItemRowIndex(rows)),
  };
}

export function togglePattern(state: SweepUiState, pattern: string): SweepUiState {
  const disabledPatterns = new Set(state.disabledPatterns);
  if (disabledPatterns.has(pattern)) {
    disabledPatterns.delete(pattern);
  } else {
    disabledPatterns.add(pattern);
  }
  return {
    ...state,
    disabledPatterns,
    patternsDirty: true,
    focus: "patterns",
  };
}

export function setFocus(input: SweepUiState, focus: UiFocus): SweepUiState {
  // Leaving the list abandons any half-made visual range.
  const state =
    focus !== "list" && input.visualAnchorId !== null ? { ...input, visualAnchorId: null } : input;
  if (focus === "sidebar") {
    const sidebarRows = sidebarRowsFor(state);
    return {
      ...state,
      focus,
      sidebarIndex: scopeFilterToSidebarIndex(state.scopeFilter, sidebarRows),
    };
  }

  if (focus === "patterns") {
    return {
      ...state,
      focus,
      patternIndex: clamp(state.patternIndex, 0, Math.max(0, allPatterns(state).length - 1)),
    };
  }

  return { ...state, focus };
}

export function setPatternIndex(state: SweepUiState, patternIndex: number): SweepUiState {
  const count = allPatterns(state).length;
  if (count === 0) return { ...state, patternIndex: 0 };
  return {
    ...state,
    patternIndex: clamp(patternIndex, 0, count - 1),
    focus: "patterns",
  };
}

export function moveSidebarCursor(state: SweepUiState, delta: number): SweepUiState {
  const sidebarRows = sidebarRowsFor(state);
  if (sidebarRows.length === 0) return state;

  const nextIndex = clamp(state.sidebarIndex + delta, 0, sidebarRows.length - 1);
  return { ...state, sidebarIndex: nextIndex };
}

export function applySidebarScope(state: SweepUiState): SweepUiState {
  const sidebarRows = sidebarRowsFor(state);
  const scopeFilter = sidebarIndexToScopeFilter(state.sidebarIndex, sidebarRows);
  return setScopeFilter({ ...state, focus: "list" }, scopeFilter);
}

export function toggleScopeExpand(state: SweepUiState): SweepUiState {
  const rows = sidebarRowsFor(state);
  const row = rows[state.sidebarIndex];
  if (!row?.hasChildren || row.key === null) return state;
  const expandedScopes = new Set(state.expandedScopes);
  if (expandedScopes.has(row.key)) expandedScopes.delete(row.key);
  else expandedScopes.add(row.key);
  return { ...state, expandedScopes };
}

export function collapseScopeFolder(state: SweepUiState): SweepUiState {
  const rows = sidebarRowsFor(state);
  const row = rows[state.sidebarIndex];
  if (row?.hasChildren && row.key !== null && state.expandedScopes.has(row.key)) {
    const expandedScopes = new Set(state.expandedScopes);
    expandedScopes.delete(row.key);
    return { ...state, expandedScopes };
  }
  return setFocus(state, "list");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function setThemeMode(state: SweepUiState, themeMode: ThemeMode): SweepUiState {
  return { ...state, themeMode };
}

/**
 * Merge streaming candidates by id (sized re-upserts replace discovery stubs).
 *
 * Newly discovered ids seed into the queue from `selectedByDefault`, matching
 * the non-streaming plan's `selectedCandidateIds`; without this every `sweep
 * ui` session would finish scanning with an empty queue. A sized re-upsert
 * never re-seeds: once an id exists, its queued state is whatever the user
 * (or the policy) last left it.
 */
export function upsertCandidates(state: SweepUiState, incoming: ScanCandidate[]): SweepUiState {
  if (incoming.length === 0) return state;
  invalidateSelectorCache();

  const anchoredId = getCurrentCandidate(state)?.id;
  const byId = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));
  const selectedIds = new Set(state.selectedIds);
  for (const candidate of incoming) {
    const existing = byId.get(candidate.id);
    // Never let a sized update clobber a user selection decision - ids are
    // deterministic so sized entries arrive with identical fields except bytes.
    byId.set(candidate.id, existing ? { ...existing, ...candidate } : candidate);
    if (
      !existing &&
      candidate.selectedByDefault &&
      candidate.riskTier !== "blocked" &&
      !state.selectionTouched.has(candidate.id)
    ) {
      selectedIds.add(candidate.id);
    }
  }

  return reanchor({ ...state, candidates: [...byId.values()], selectedIds }, undefined, anchoredId);
}

/** Re-run display rows and keep the cursor on `anchoredId` (or nearest item). */
function reanchor(
  state: SweepUiState,
  overrides?: Partial<SweepUiState>,
  anchoredId?: string,
): SweepUiState {
  const next = { ...state, ...overrides };
  const rows = buildDisplayRows(next);
  const id = anchoredId ?? getCurrentCandidate(state)?.id;
  const index = id ? rows.findIndex((row) => row.kind === "item" && row.candidateId === id) : -1;

  return {
    ...next,
    rowIndex: index >= 0 ? index : snapRowIndexToItem(rows, firstItemRowIndex(rows)),
  };
}

/** After structural changes, snap the cursor to the closest surviving item row. */
function snapToNearestItem(state: SweepUiState): SweepUiState {
  const rows = buildDisplayRows(state);
  return { ...state, rowIndex: snapRowIndexToItem(rows, state.rowIndex) };
}

export function setScanning(state: SweepUiState, scanning: boolean): SweepUiState {
  if (state.scanning === scanning) return state;
  if (scanning) return { ...state, scanning: true, orderPinned: true };

  // The scan is over (finished or failed): unpin and sort once.
  const settled: SweepUiState = { ...state, scanning: false, orderPinned: false };

  // If the cursor is still parked where it was auto-placed, the user never
  // chose it - land them on the biggest win instead of wherever the first
  // artifact discovered happens to have sorted to.
  if (state.rowIndex === firstItemRowIndex(buildDisplayRows(state))) {
    const rows = buildDisplayRows(settled);
    return { ...settled, rowIndex: snapRowIndexToItem(rows, firstItemRowIndex(rows)) };
  }

  // The user moved the cursor, so that choice outranks the sort: the re-sort
  // renumbers every row, hold onto their artifact rather than its index.
  return reanchor(state, { scanning: false, orderPinned: false });
}

export function setScannedDirs(state: SweepUiState, scannedDirs: number): SweepUiState {
  if (state.scannedDirs === scannedDirs) return state;
  return { ...state, scannedDirs };
}

export function setSkippedDirs(state: SweepUiState, skippedDirs: number): SweepUiState {
  if (state.skippedDirs === skippedDirs) return state;
  return { ...state, skippedDirs };
}

/**
 * Fold the finished scan's authoritative plan back into live state.
 *
 * Streaming feeds per-entry stubs through `candidateFromEntry`, which enriches
 * one candidate at a time - cross-candidate insights (workspace stubs, symlink
 * aliases) can only run once the whole set exists. When the engine finishes it
 * hands back a real `buildPlan` result; this swaps the stub candidates for the
 * enriched ones and reconciles the queue:
 *
 * - ids the user touched keep the user's decision, even if the policy now
 *   disagrees (e.g. enrichment demoted a workspace stub to caution);
 * - everything else follows the plan's `selectedCandidateIds` policy set.
 */
export function finalizeScan(state: SweepUiState, plan: ScanPlan | undefined): SweepUiState {
  if (!plan) return setScanning(state, false);

  const policyIds = new Set(plan.selectedCandidateIds);
  const selectedIds = new Set<string>();
  for (const candidate of plan.candidates) {
    const keep = state.selectionTouched.has(candidate.id)
      ? state.selectedIds.has(candidate.id)
      : policyIds.has(candidate.id);
    if (keep && candidate.riskTier !== "blocked") selectedIds.add(candidate.id);
  }

  const merged: SweepUiState = {
    ...state,
    candidates: plan.candidates,
    selectedIds,
    scannedDirs: plan.summary.scannedDirs > 0 ? plan.summary.scannedDirs : state.scannedDirs,
  };
  return setScanning(merged, false);
}

export function toggleSortBy(state: SweepUiState): SweepUiState {
  invalidateSelectorCache();
  const next = SORT_ORDER[(SORT_ORDER.indexOf(state.sortBy) + 1) % SORT_ORDER.length];
  const sortBy: UiSortBy = next ?? "size";
  // The user asked for this reorder, so apply it now rather than silently
  // doing nothing until the scan finishes. Movement they requested is fine.
  return reanchor(state, { sortBy, orderPinned: false, visualAnchorId: null });
}

/** Collapse or expand one scope group in the artifact list. */
export function toggleGroup(state: SweepUiState, groupKey: string): SweepUiState {
  const collapsedGroups = new Set(state.collapsedGroups);
  if (collapsedGroups.has(groupKey)) {
    collapsedGroups.delete(groupKey);
  } else {
    collapsedGroups.add(groupKey);
  }
  invalidateSelectorCache();
  // Collapsing may remove the focused row; re-anchor to a visible item.
  return snapToNearestItem({ ...state, collapsedGroups });
}

/** Expand every scope group. */
export function expandAllGroups(state: SweepUiState): SweepUiState {
  if (state.collapsedGroups.size === 0) return state;
  invalidateSelectorCache();
  return snapToNearestItem({ ...state, collapsedGroups: new Set<string>() });
}

/**
 * One step of the esc ladder - walk backwards through UI state instead of
 * quitting. Returns null when there is nothing left to unwind.
 */
export function escapeStep(state: SweepUiState): SweepUiState | null {
  // A half-made range is the innermost layer: esc drops it and nothing else.
  if (state.visualAnchorId !== null) return cancelVisual(state);
  if (state.focus === "patterns") {
    return setFocus(state, "list");
  }
  if (state.focus === "sidebar") {
    return setFocus(state, "list");
  }
  if (state.focus === "search") {
    return setFocus(state, "list");
  }

  // List focus - peel off view narrowing one layer at a time.
  if (state.riskFilter !== "all") {
    return setRiskFilter(state, "all");
  }
  if (state.scopeFilter !== null) {
    return setScopeFilter(state, null);
  }
  if (state.filter.length > 0) {
    return setFilter(state, "");
  }
  if (state.collapsedGroups.size > 0) {
    return expandAllGroups(state);
  }

  return null;
}

/**
 * Begin a fresh scan generation: drop discovered artifacts and selections,
 * keep user view/config preferences (theme, patterns editor state, filters).
 */
export function resetForRescan(state: SweepUiState): SweepUiState {
  invalidateSelectorCache();
  return {
    ...state,
    candidates: [],
    selectedIds: new Set<string>(),
    selectionTouched: new Set<string>(),
    rowIndex: 0,
    visualAnchorId: null,
    sidebarIndex: 0,
    scopeFilter: null,
    collapsedGroups: new Set<string>(),
    scanning: true,
    orderPinned: true,
    scannedDirs: 0,
    skippedDirs: 0,
  };
}

export function moveCursor(state: SweepUiState, delta: number): SweepUiState {
  const rows = buildDisplayRows(state);
  if (rows.length === 0) return state;

  return {
    ...state,
    rowIndex: moveItemRowIndex(rows, state.rowIndex, delta),
  };
}

export function setRowIndex(state: SweepUiState, rowIndex: number): SweepUiState {
  const rows = buildDisplayRows(state);
  if (rows.length === 0) return state;

  return {
    ...state,
    rowIndex: snapRowIndexToItem(rows, rowIndex),
  };
}

export function toggleCurrentSelection(state: SweepUiState): SweepUiState {
  const candidate = getCurrentCandidate(state);
  if (!candidate) return state;
  return toggleSelectionById(state, candidate.id);
}

function candidateById(state: SweepUiState, candidateId: string): ScanCandidate | undefined {
  for (const candidate of state.candidates) {
    if (candidate.id === candidateId) return candidate;
  }
  return undefined;
}

export function toggleSelectionById(state: SweepUiState, candidateId: string): SweepUiState {
  const candidate = candidateById(state, candidateId);
  if (!candidate) return state;
  // Blocked items are hard-locked everywhere. Dangerous items CAN be selected,
  // but only deliberately (one at a time) and always behind the red confirm.
  if (candidate.riskTier === "blocked") {
    return state;
  }

  const selectedIds = new Set(state.selectedIds);
  if (selectedIds.has(candidate.id)) {
    selectedIds.delete(candidate.id);
  } else {
    selectedIds.add(candidate.id);
  }
  const selectionTouched = new Set(state.selectionTouched);
  selectionTouched.add(candidate.id);

  return { ...state, selectedIds, selectionTouched };
}

export function countSelectedDangerous(state: SweepUiState): number {
  let count = 0;
  for (const candidate of state.candidates) {
    if (state.selectedIds.has(candidate.id) && candidate.riskTier === "dangerous") {
      count += 1;
    }
  }
  return count;
}

export function selectSafeOnly(state: SweepUiState): SweepUiState {
  const selectedIds = new Set(state.selectedIds);
  const selectionTouched = new Set(state.selectionTouched);
  for (const candidate of getVisibleCandidates(state)) {
    if (candidate.riskTier === "safe") {
      selectedIds.add(candidate.id);
    }
    selectionTouched.add(candidate.id);
  }

  return { ...state, selectedIds, selectionTouched };
}

export function selectVisible(state: SweepUiState, includeDangerous: boolean): SweepUiState {
  const selectedIds = new Set(state.selectedIds);
  const selectionTouched = new Set(state.selectionTouched);
  for (const candidate of getVisibleCandidates(state)) {
    selectionTouched.add(candidate.id);
    if (candidate.riskTier === "blocked") continue;
    if (candidate.riskTier === "dangerous" && !includeDangerous) continue;
    selectedIds.add(candidate.id);
  }

  return { ...state, selectedIds, selectionTouched };
}

export interface ScopeToggleResult {
  state: SweepUiState;
  queued: number;
  unqueued: number;
  /** Dangerous or blocked rows in the scope that were left alone. */
  skipped: number;
}

/**
 * Queue or dequeue artifacts under a sidebar scope.
 *
 * Bulk gestures never queue dangerous or blocked rows - same rule as `a` and
 * visual ranges, since a scope `space` could otherwise smuggle a dangerous
 * artifact behind the confirm dialog. Dangerous entries deliberately queued
 * row-by-row are also left alone when the toggle reverses.
 * `scopeKey === null` is the "all scopes" row - the whole target.
 */
export function toggleScopeSelection(
  state: SweepUiState,
  scopeKey: string | null,
): ScopeToggleResult {
  const inScope = state.candidates.filter(
    (candidate) =>
      scopeKey === null ||
      candidateMatchesScope(artifactScopeKey(state.targetDir, candidate.path), scopeKey),
  );
  const eligible = inScope.filter(
    (candidate) => candidate.riskTier !== "blocked" && candidate.riskTier !== "dangerous",
  );
  const skipped = inScope.length - eligible.length;
  if (eligible.length === 0) return { state, queued: 0, unqueued: 0, skipped };

  const selectedIds = new Set(state.selectedIds);
  const allSelected = eligible.every((candidate) => selectedIds.has(candidate.id));
  const selectionTouched = new Set(state.selectionTouched);
  for (const candidate of eligible) {
    selectionTouched.add(candidate.id);
    if (allSelected) selectedIds.delete(candidate.id);
    else selectedIds.add(candidate.id);
  }
  return {
    state: { ...state, selectedIds, selectionTouched },
    queued: allSelected ? 0 : eligible.length,
    unqueued: allSelected ? eligible.length : 0,
    skipped,
  };
}

/** Same toggle, addressed by the sidebar cursor row instead of a scope key. */
export function toggleSidebarScopeSelection(state: SweepUiState): ScopeToggleResult {
  const rows = sidebarRowsFor(state);
  const row = rows[state.sidebarIndex];
  if (!row) return { state, queued: 0, unqueued: 0, skipped: 0 };
  return toggleScopeSelection(state, row.key);
}

export interface VisualRange {
  /** Item candidate ids inside the range, in list order. */
  ids: string[];
  /** Display-row bounds, inclusive; headers inside the span are not in `ids`. */
  from: number;
  to: number;
}

/** The live visual range, or null when not in visual mode or the anchor left the list. */
export function visualRange(state: SweepUiState): VisualRange | null {
  if (state.visualAnchorId === null) return null;
  const rows = buildDisplayRows(state);
  const anchor = rows.findIndex(
    (row) => row.kind === "item" && row.candidateId === state.visualAnchorId,
  );
  if (anchor < 0) return null;
  const from = Math.min(anchor, state.rowIndex);
  const to = Math.max(anchor, state.rowIndex);
  const ids: string[] = [];
  for (let index = from; index <= to; index += 1) {
    const row = rows[index];
    if (row?.kind === "item") ids.push(row.candidateId);
  }
  return { ids, from, to };
}

/** Anchor a range on the row under the cursor. No-op on a header row. */
export function startVisual(state: SweepUiState): SweepUiState {
  const current = getCurrentCandidate(state);
  if (!current) return state;
  return { ...state, visualAnchorId: current.id };
}

export function cancelVisual(state: SweepUiState): SweepUiState {
  return state.visualAnchorId === null ? state : { ...state, visualAnchorId: null };
}

export interface VisualApplyResult {
  state: SweepUiState;
  queued: number;
  unqueued: number;
  /** Dangerous or blocked rows in the range that were left alone. */
  skipped: number;
}

/**
 * Queue (or, when everything eligible is already queued, unqueue) the range.
 *
 * Like bulk select, a range never queues dangerous or blocked artifacts:
 * dangerous ones enter the queue only through a deliberate single-row toggle,
 * so sweeping a span cannot smuggle one behind the confirm dialog.
 */
export function applyVisualRange(state: SweepUiState): VisualApplyResult {
  const range = visualRange(state);
  const cleared = cancelVisual(state);
  if (!range) return { state: cleared, queued: 0, unqueued: 0, skipped: 0 };

  const byId = new Map(state.candidates.map((candidate) => [candidate.id, candidate]));
  const eligible: ScanCandidate[] = [];
  let skipped = 0;
  for (const id of range.ids) {
    const candidate = byId.get(id);
    if (!candidate) continue;
    if (candidate.riskTier === "blocked" || candidate.riskTier === "dangerous") skipped += 1;
    else eligible.push(candidate);
  }
  if (eligible.length === 0) return { state: cleared, queued: 0, unqueued: 0, skipped };

  const selectedIds = new Set(state.selectedIds);
  const selectionTouched = new Set(state.selectionTouched);
  const allQueued = eligible.every((candidate) => selectedIds.has(candidate.id));
  for (const candidate of eligible) {
    selectionTouched.add(candidate.id);
    if (allQueued) selectedIds.delete(candidate.id);
    else selectedIds.add(candidate.id);
  }
  return {
    state: { ...cleared, selectedIds, selectionTouched },
    queued: allQueued ? 0 : eligible.length,
    unqueued: allQueued ? eligible.length : 0,
    skipped,
  };
}

export function clearSelection(state: SweepUiState): SweepUiState {
  // Everything currently known counts as user-handled: a mid-scan `u` means
  // "queue nothing I can see", and the end-of-scan policy pass must not
  // silently re-add those same artifacts behind the user's back.
  const selectionTouched = new Set(state.selectionTouched);
  for (const candidate of state.candidates) selectionTouched.add(candidate.id);
  return { ...state, selectedIds: new Set<string>(), selectionTouched };
}

export function getCurrentCandidate(state: SweepUiState): ScanCandidate | undefined {
  const candidateId = rowCandidateId(buildDisplayRows(state), state.rowIndex);
  return candidateId ? candidateById(state, candidateId) : undefined;
}

export function getUiSummary(state: SweepUiState): SweepUiSummary {
  const visible = getVisibleCandidates(state);
  let visibleSelectedCount = 0;
  let dangerousVisibleCount = 0;

  for (const candidate of visible) {
    if (state.selectedIds.has(candidate.id)) visibleSelectedCount++;
    if (candidate.riskTier === "dangerous") dangerousVisibleCount++;
  }

  // Count the queue over every candidate, matching applyUiSelection exactly.
  // Filtering the view must never change what apply is about to delete.
  let selectedCount = 0;
  let selectedBytes = 0;
  for (const candidate of state.candidates) {
    if (candidate.riskTier === "blocked") continue; // apply drops these too
    if (!state.selectedIds.has(candidate.id)) continue;
    selectedCount++;
    selectedBytes += candidate.estimatedBytes;
  }

  return {
    visibleCount: visible.length,
    selectedCount,
    selectedBytes,
    visibleSelectedCount,
    dangerousVisibleCount,
  };
}

export function applyUiSelection(plan: ScanPlan, state: SweepUiState): ScanPlan {
  const selectedSet = new Set(state.selectedIds);
  const selectedCandidateIds: string[] = [];
  let totalBytes = 0;
  const riskCounts: ScanPlan["summary"]["riskCounts"] = {
    safe: 0,
    caution: 0,
    dangerous: 0,
    blocked: 0,
  };

  for (const candidate of state.candidates) {
    totalBytes += candidate.estimatedBytes;
    riskCounts[candidate.riskTier] += 1;
    if (selectedSet.has(candidate.id) && candidate.riskTier !== "blocked") {
      selectedCandidateIds.push(candidate.id);
    }
  }

  return {
    ...plan,
    targetDir: state.targetDir,
    candidates: state.candidates.slice(),
    selectedCandidateIds,
    summary: {
      ...plan.summary,
      candidateCount: state.candidates.length,
      selectedCount: selectedCandidateIds.length,
      estimatedTotalBytes: totalBytes,
      riskCounts,
    },
  };
}

export function rescanConfigFromState(state: SweepUiState): {
  disabledPatterns: string[];
  extraPatterns: string[];
} {
  return {
    disabledPatterns: [...state.disabledPatterns],
    extraPatterns: [...state.extraPatterns],
  };
}
