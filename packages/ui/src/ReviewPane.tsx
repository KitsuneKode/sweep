import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { bold, dim, fg, StyledText, t, type TextChunk } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { ArtifactList } from "./ArtifactList.js";
import { ActionButton } from "./ActionButton.js";
import { PatternPanel } from "./PatternPanel.js";
import { ScopeSidebar } from "./ScopeSidebar.js";
import { DotMatrix, DotStrip } from "./widgets.js";
import type { UiDisplayRow } from "./rows.js";
import {
  moveCursor,
  moveSidebarCursor,
  setFilter,
  setRowIndex,
  setScopeFilter,
  toggleGroup,
  visualRange,
  type SweepUiState,
  type UiFocus,
} from "./state.js";
import { filterAdvice } from "./filter-query.js";
import { activeFacetCount } from "./filter-facets.js";
import { formatBytes } from "@kitsunekode/sweep-display";

const FILTER_PLACEHOLDER = "name, kind:target, >100MB, older:30d, risk:caution";
import type { ThemeTokens } from "./theme.js";
import { cellWidth, clipCells } from "./text-cells.js";

export interface ReviewPaneProps {
  state: SweepUiState;
  plan: ScanPlan;
  tokens: ThemeTokens;
  showSidebar: boolean;
  sidebarWidth: number;
  displayRows: UiDisplayRow[];
  visibleItems: ScanCandidate[];
  candidatesById: ReadonlyMap<string, ScanCandidate>;
  onMutate: (fn: (s: SweepUiState) => SweepUiState) => void;
  onFocusPanel: (focus: UiFocus) => void;
  onToggleSelection: (candidateId: string) => void;
  /** Enter on the pattern pane's add line. */
  onSubmitPatternDraft: () => void;
  onSavePatterns?: () => void;
  onInspectPattern?: (pattern: string) => void;
  /** Measured artifact-pane viewport height for real page steps. */
  onViewportRows?: (rows: number) => void;
  onToggleScopeQueue?: (scope: string | null) => void;
  /** Live elapsed for the running scan, ms - ticks at 4Hz from the app. */
  scanElapsedMs?: number;
  /** Opens the facet filter picker. */
  onOpenFilter?: () => void;
}

export function ReviewPane({
  state,
  tokens,
  showSidebar,
  sidebarWidth,
  displayRows,
  visibleItems,
  candidatesById,
  onMutate,
  onFocusPanel,
  onToggleSelection,
  onSubmitPatternDraft,
  onSavePatterns,
  onInspectPattern,
  onViewportRows,
  scanElapsedMs,
  onToggleScopeQueue,
  onOpenFilter,
}: ReviewPaneProps) {
  const dimensions = useTerminalDimensions();
  // Artifact pane inner width: total terminal width minus sidebar (if shown),
  // outer padding (2), pane border+padding (4). The panes touch: no gap.
  const artifactPaneInnerWidth = Math.max(
    1,
    dimensions.width - (showSidebar ? sidebarWidth : 0) - 2 - 4,
  );

  const visual = visualRange(state);
  const hasFilter = state.filter.length > 0 || state.riskFilter !== "all";
  const scopeEmpty = state.scopeFilter !== null && visibleItems.length === 0;
  const nothingFound = visibleItems.length === 0 && !scopeEmpty && !state.scanning;
  const searchFocused = state.focus === "search";
  const patternsPane = state.focus === "patterns" || state.focus === "patternInput";
  const advice = patternsPane ? null : filterAdvice(state.filter);
  const listFocused = state.focus === "list" || patternsPane;
  const emptyScan = state.scanning && state.candidates.length === 0;
  // While a filter is typed or held, the bar is the query: prompt, field and
  // what it caught. The scope it applies within moves to the pane title.
  const filtering = searchFocused || state.filter.length > 0;
  const facetCount = activeFacetCount(state.filter);
  const scopeName =
    state.scopeFilter === null
      ? "all folders"
      : state.scopeFilter === ""
        ? "target root"
        : sanitizeTerminalText(state.scopeFilter);
  let visibleBytes = 0;
  if (filtering) for (const item of visibleItems) visibleBytes += item.estimatedBytes;

  // The pane title is the one indicator that survives every terminal width -
  // sidebar and footer chips both hide on narrow layouts. An active scope or
  // risk filter must always be legible somewhere the user is already looking.
  const titleParts = ["artifacts"];
  if (state.riskFilter !== "all") titleParts.push(state.riskFilter);
  const paneTitle = patternsPane
    ? " › patterns "
    : filtering
      ? ` ${searchFocused ? "› " : ""}filter · ${scopeName} `
      : ` ${titleParts.join(" · ")} `;

  return (
    <box width="100%" flexGrow={1} minHeight={0} flexDirection="row">
      {showSidebar ? (
        <box
          width={sidebarWidth}
          height="100%"
          flexDirection="column"
          // A rule over each column instead of a box around it: the focused
          // one is named in the accent, the other in a quiet voice.
          borderStyle="single"
          border={["top", "right"]}
          borderColor={tokens.border}
          title={state.focus === "sidebar" ? " › folders " : " folders "}
          titleColor={state.focus === "sidebar" ? tokens.accent : tokens.textMuted}
          backgroundColor={tokens.bg}
          overflow="hidden"
          paddingLeft={1}
          paddingRight={2}
          paddingBottom={0}
        >
          <ScopeSidebar
            state={state}
            tokens={tokens}
            focused={state.focus === "sidebar"}
            paneWidth={sidebarWidth - 4}
            onApplyScope={(scopeFilter) => {
              onMutate((s) => setScopeFilter(s, scopeFilter));
              onFocusPanel("list");
            }}
            onCursorDelta={(delta) => onMutate((s) => moveSidebarCursor(s, delta))}
            onSetCursor={(index) => onMutate((s) => moveSidebarCursor(s, index - s.sidebarIndex))}
            {...(onToggleScopeQueue ? { onToggleQueue: onToggleScopeQueue } : {})}
            onToggleExpand={(key) =>
              onMutate((s) => {
                const expandedScopes = new Set(s.expandedScopes);
                if (expandedScopes.has(key)) expandedScopes.delete(key);
                else expandedScopes.add(key);
                return { ...s, expandedScopes };
              })
            }
          />
        </box>
      ) : null}
      <box
        flexGrow={1}
        height="100%"
        flexDirection="column"
        gap={0}
        borderStyle="single"
        border={["top"]}
        borderColor={tokens.border}
        title={paneTitle}
        titleColor={listFocused || searchFocused ? tokens.accent : tokens.textMuted}
        backgroundColor={tokens.bg}
        overflow="hidden"
        paddingX={2}
        paddingBottom={0}
      >
        {patternsPane ? null : (
          <box width="100%" flexShrink={0} flexDirection="column">
            <box height={1} width="100%" flexDirection="row" flexShrink={0} gap={1}>
              {/* Positions stay fixed (nulls hold their slot) so the input never
                  remounts and loses focus when the bar switches modes. */}
              {!filtering && state.scopeFilter !== null ? (
                <ActionButton
                  tokens={tokens}
                  label="← All folders"
                  onPress={() => onMutate((s) => setScopeFilter(s, null))}
                />
              ) : null}
              {filtering ? null : (
                <text
                  flexShrink={1}
                  minWidth={1}
                  content={t`${fg(tokens.textDim)(artifactPaneInnerWidth >= 64 ? "Viewing: " : "")}${bold(
                    fg(tokens.text)(scopeName),
                  )}`}
                  wrapMode="none"
                />
              )}
              {filtering ? (
                <text
                  content={t`${bold(fg(searchFocused ? tokens.accent : tokens.textMuted)("/"))}`}
                  wrapMode="none"
                  flexShrink={0}
                />
              ) : (
                <box flexGrow={1} flexShrink={1} />
              )}
              <box
                flexGrow={filtering ? 1 : 0}
                flexShrink={1}
                minWidth={8}
                width={filtering ? "auto" : 12}
                height={1}
              >
                <input
                  focused={searchFocused}
                  value={state.filter}
                  maxLength={512}
                  placeholder={searchFocused ? FILTER_PLACEHOLDER : "/ filter"}
                  backgroundColor={tokens.surfaceInset}
                  focusedBackgroundColor={tokens.surfaceInset}
                  textColor={tokens.text}
                  placeholderColor={tokens.textDim}
                  cursorColor={tokens.accent}
                  onInput={(value: string) => onMutate((s) => setFilter(s, value))}
                  onSubmit={() => onFocusPanel("list")}
                />
              </box>
              {onOpenFilter && artifactPaneInnerWidth >= 56 ? (
                <ActionButton
                  tokens={tokens}
                  label={facetCount > 0 ? `Filter ${facetCount}` : "Filter"}
                  hint={facetCount > 0 ? undefined : "f"}
                  {...(facetCount > 0 ? { color: tokens.accent } : {})}
                  onPress={onOpenFilter}
                />
              ) : null}
              {filtering ? (
                // The answer to "what did my filter catch": count and bytes,
                // right where the query is typed.
                <text
                  flexShrink={0}
                  content={
                    visibleItems.length === 0
                      ? t`${fg(tokens.warning)("no matches")}`
                      : t`${bold(fg(tokens.text)(visibleItems.length.toLocaleString()))}${fg(
                          tokens.textMuted,
                        )(
                          ` of ${state.candidates.length.toLocaleString()} · ${formatBytes(visibleBytes)}`,
                        )}`
                  }
                  wrapMode="none"
                />
              ) : artifactPaneInnerWidth >= 48 ? (
                <text
                  flexShrink={0}
                  content={t`${fg(tokens.textMuted)(
                    state.sortBy === "size"
                      ? "Largest first"
                      : state.sortBy === "name"
                        ? "Name order"
                        : "Oldest first",
                  )} ${fg(tokens.textDim)("o")}`}
                  wrapMode="none"
                />
              ) : null}
            </box>
            {advice ? (
              <text content={sanitizeTerminalText(advice)} fg={tokens.warning} wrapMode="none" />
            ) : null}
          </box>
        )}
        {state.scanning && state.candidates.length > 0 ? (
          <ScanningStrip
            tokens={tokens}
            found={state.candidates.length}
            pendingSizes={Math.max(0, state.candidates.length - state.scanSizedCount)}
            scannedDirs={state.scannedDirs}
            skippedDirs={state.skippedDirs}
            currentDir={state.scanCurrentDir}
            elapsedMs={scanElapsedMs}
            orderPinned={state.orderPinned}
            width={artifactPaneInnerWidth}
          />
        ) : null}
        {patternsPane ? (
          <PatternPanel
            state={state}
            tokens={tokens}
            paneWidth={artifactPaneInnerWidth}
            onMutate={onMutate}
            onSubmitDraft={onSubmitPatternDraft}
            {...(onSavePatterns ? { onSave: onSavePatterns } : {})}
            {...(onInspectPattern ? { onInspect: onInspectPattern } : {})}
          />
        ) : emptyScan ? (
          <ScanningPanel
            tokens={tokens}
            scannedDirs={state.scannedDirs}
            currentDir={state.scanCurrentDir}
          />
        ) : scopeEmpty ? (
          <box flexGrow={1} justifyContent="center" alignItems="center" padding={2} gap={1}>
            <text content="No artifacts in this scope." fg={tokens.textMuted} wrapMode="none" />
            <text content="h or esc returns to all scopes." fg={tokens.textDim} wrapMode="none" />
          </box>
        ) : nothingFound ? (
          <box flexGrow={1} justifyContent="center" alignItems="center" padding={2}>
            <text
              content={
                hasFilter
                  ? state.filter.length > 0
                    ? `No artifacts match "${sanitizeTerminalText(state.filter)}".`
                    : "No artifacts match the current filter."
                  : "No artifacts found."
              }
              fg={tokens.textMuted}
            />
            <text
              content={hasFilter ? "esc clears the filter. / to search." : "r rescans from disk."}
              fg={tokens.textDim}
            />
          </box>
        ) : (
          <ArtifactList
            rows={displayRows}
            candidatesById={candidatesById}
            selectedIds={state.selectedIds}
            currentRowIndex={state.rowIndex}
            visualRange={visual}
            focused={state.focus === "list"}
            tokens={tokens}
            paneWidth={artifactPaneInnerWidth}
            targetDir={state.targetDir}
            onToggleSelection={onToggleSelection}
            onToggleGroup={(groupKey) => onMutate((s) => toggleGroup(s, groupKey))}
            onSetCursor={(rowIndex) => onMutate((s) => setRowIndex(s, rowIndex))}
            onCursorDelta={(delta) => onMutate((s) => moveCursor(s, delta))}
            onViewportRows={onViewportRows}
          />
        )}
      </box>
    </box>
  );
}

/** Live elapsed readout - coarse enough not to flicker: 0.5s, 12s, 2m 4s. */
function formatElapsed(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms - minutes * 60_000) / 1000)}s`;
}

/** Keep both root context and the leaf; the inspector exposes the full path. */
function tailPath(dir: string, max: number): string {
  const clean = sanitizeTerminalText(dir);
  if (cellWidth(clean) <= max) return clean;
  // Keep graphemes whole. The inspector exposes the full path.
  return clipCells(clean, max, true);
}

/**
 * Empty discovery keeps work and stop instructions visible even when activity
 * animation is paused. No full-tree completion percentage is known yet.
 */
function ScanningPanel({
  tokens,
  scannedDirs,
  currentDir,
}: {
  tokens: ThemeTokens;
  scannedDirs: number;
  currentDir: string | null;
}) {
  return (
    <box flexGrow={1} justifyContent="center" alignItems="center" padding={2} gap={1}>
      <DotMatrix tokens={tokens} pattern="pulseRings" />
      <text content="" />
      <text content="Scanning for artifacts" fg={tokens.text} wrapMode="word" />
      <text
        content={
          currentDir !== null
            ? tailPath(currentDir, 40)
            : scannedDirs > 0
              ? `${scannedDirs.toLocaleString()} directories walked`
              : "Walking the project tree…"
        }
        fg={tokens.textMuted}
        wrapMode="none"
      />
      <text content="" />
      <text
        content="Ctrl+C stop · m pause / resume animation"
        fg={tokens.textDim}
        wrapMode="word"
      />
    </box>
  );
}

/**
 * Slim live strip shown once results are streaming: the list is already usable,
 * so progress belongs in one row of chrome instead of blocking the pane.
 */
function ScanningStrip({
  tokens,
  found,
  pendingSizes,
  scannedDirs,
  skippedDirs,
  currentDir,
  elapsedMs,
  orderPinned,
  width,
}: {
  tokens: ThemeTokens;
  width: number;
  found: number;
  pendingSizes: number;
  scannedDirs: number;
  skippedDirs: number;
  currentDir: string | null;
  elapsedMs: number | undefined;
  orderPinned: boolean;
}) {
  const dirs = scannedDirs > 0 ? `${scannedDirs.toLocaleString()} dirs` : "walking\u2026";
  // One line, filled in priority order: a part that does not fit is left out
  // whole rather than drawn over its neighbour.
  const sep = dim("  \u00b7  ");
  const parts: Array<{ text: string; chunk: TextChunk }> = [];
  const push = (text: string, color: string) => parts.push({ text, chunk: fg(color)(text) });
  push(`${found.toLocaleString()} found`, tokens.textSecondary);
  // Unreadable/cycled dirs mean the result set is partial - that must be
  // visible, not quietly absorbed into a total.
  if (skippedDirs > 0) push(`${skippedDirs} skipped`, tokens.warning);
  if (pendingSizes > 0) push(`${pendingSizes.toLocaleString()} sizing`, tokens.textMuted);
  push(dirs, tokens.textMuted);
  if (elapsedMs !== undefined && elapsedMs >= 250) push(formatElapsed(elapsedMs), tokens.textDim);
  // Sizes arrive after discovery, so the list is held in discovery order
  // until the scan ends. Say so, or it just looks unsorted.
  if (orderPinned) push("found order \u00b7 sorts when done", tokens.textDim);
  // ncdu's "current item" idiom - the path keeps moving even when the
  // counters stall, which is the proof-of-life a big tree needs.
  const lead = "scanning  ";
  let room = Math.max(0, width - 9 - lead.length);
  const shown: typeof parts = [];
  for (const part of parts) {
    const cost = cellWidth(part.text) + (shown.length > 0 ? 5 : 0);
    if (cost > room) continue;
    shown.push(part);
    room -= cost;
  }
  const pathRoom = room - 5;
  const path =
    currentDir !== null && pathRoom >= 12 ? tailPath(currentDir, Math.min(40, pathRoom)) : "";
  const chunks: TextChunk[] = [bold(fg(tokens.accent)("scanning")), fg(tokens.textMuted)("  ")];
  shown.forEach((part, index) => {
    if (index > 0) chunks.push(sep);
    chunks.push(part.chunk);
  });
  if (path) chunks.push(sep, fg(tokens.textDim)(path));
  return (
    <box
      width="100%"
      height={1}
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      gap={1}
      paddingLeft={1}
    >
      <DotStrip tokens={tokens} width={7} pattern="scan" />
      <text content={new StyledText(chunks)} wrapMode="none" />
    </box>
  );
}
