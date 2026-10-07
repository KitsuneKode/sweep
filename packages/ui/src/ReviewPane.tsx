import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { bold, dim, fg, t } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { ArtifactList } from "./ArtifactList.js";
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
import { FILTER_HINT, filterAdvice } from "./filter-query.js";
import type { ThemeTokens } from "./theme.js";

export interface ReviewPaneProps {
  state: SweepUiState;
  plan: ScanPlan;
  tokens: ThemeTokens;
  showSidebar: boolean;
  sidebarWidth: number;
  displayRows: UiDisplayRow[];
  visibleItems: ScanCandidate[];
  candidatesById: Map<string, ScanCandidate>;
  onMutate: (fn: (s: SweepUiState) => SweepUiState) => void;
  onFocusPanel: (focus: UiFocus) => void;
  onToggleSelection: (candidateId: string) => void;
  /** Enter on the pattern pane's add line. */
  onSubmitPatternDraft: () => void;
  /** Measured artifact-pane viewport height for real page steps. */
  onViewportRows?: (rows: number) => void;
  /** Live elapsed for the running scan, ms - ticks at 4Hz from the app. */
  scanElapsedMs?: number;
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
  onViewportRows,
  scanElapsedMs,
}: ReviewPaneProps) {
  const dimensions = useTerminalDimensions();
  // Artifact pane inner width: total terminal width minus sidebar (if shown),
  // outer padding (2), pane border+padding (4). The panes touch: no gap.
  const artifactPaneInnerWidth = Math.max(
    36,
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

  // The pane title is the one indicator that survives every terminal width -
  // sidebar and footer chips both hide on narrow layouts. An active scope or
  // risk filter must always be legible somewhere the user is already looking.
  const titleParts = ["artifacts"];
  if (state.scopeFilter !== null) {
    titleParts.push(
      state.scopeFilter === "" ? "project root" : sanitizeTerminalText(state.scopeFilter),
    );
  }
  if (state.riskFilter !== "all") titleParts.push(state.riskFilter);
  const paneTitle = patternsPane
    ? " › patterns "
    : searchFocused
      ? " › filter "
      : ` ${titleParts.join(" · ")} `;

  return (
    <box width="100%" flexGrow={1} minHeight={0} flexDirection="row">
      {showSidebar ? (
        <box
          width={sidebarWidth}
          height="100%"
          flexDirection="column"
          borderStyle="rounded"
          border
          borderColor={state.focus === "sidebar" ? tokens.borderFocus : tokens.borderSoft}
          title={state.focus === "sidebar" ? " › scopes " : " scopes "}
          backgroundColor={tokens.bg}
          overflow="hidden"
          paddingX={1}
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
          />
        </box>
      ) : null}
      <box
        flexGrow={1}
        height="100%"
        flexDirection="column"
        gap={0}
        borderStyle="rounded"
        border
        borderColor={listFocused || searchFocused ? tokens.borderFocus : tokens.borderSoft}
        title={paneTitle}
        backgroundColor={tokens.surface}
        overflow="hidden"
        paddingX={1}
        paddingBottom={0}
      >
        {patternsPane ? null : (
          <box width="100%" flexShrink={0} flexDirection="column">
            <box width="100%" height={1} flexShrink={0}>
              <input
                focused={searchFocused}
                value={state.filter}
                placeholder={`Filter… ${FILTER_HINT}`}
                backgroundColor={tokens.surfaceInset}
                focusedBackgroundColor={tokens.surfaceInset}
                textColor={tokens.text}
                cursorColor={tokens.accent}
                onInput={(value: string) => onMutate((s) => setFilter(s, value))}
                onSubmit={() => onFocusPanel("list")}
              />
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
          />
        ) : null}
        {patternsPane ? (
          <PatternPanel
            state={state}
            tokens={tokens}
            paneWidth={artifactPaneInnerWidth}
            onMutate={onMutate}
            onSubmitDraft={onSubmitPatternDraft}
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

/** Keep the tail of a path - the deep dir is the informative part. */
function tailPath(dir: string, max: number): string {
  const clean = sanitizeTerminalText(dir);
  if (clean.length <= max) return clean;
  return "\u2026" + clean.slice(clean.length - (max - 1));
}

/**
 * Empty-but-scanning state. The dot matrix is the only thing on screen that
 * proves the process is alive before the first artifact lands, so it gets the
 * centre of the pane rather than a line of ellipses.
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
      <text content="Scanning for artifacts" fg={tokens.text} wrapMode="none" />
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
        content="Results stream in as they are found · ctrl-c to stop"
        fg={tokens.textDim}
        wrapMode="none"
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
}: {
  tokens: ThemeTokens;
  found: number;
  pendingSizes: number;
  scannedDirs: number;
  skippedDirs: number;
  currentDir: string | null;
  elapsedMs: number | undefined;
  orderPinned: boolean;
}) {
  const dirs = scannedDirs > 0 ? `${scannedDirs.toLocaleString()} dirs` : "walking\u2026";
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
      <text
        content={t`${bold(fg(tokens.accent)("scanning"))}  ${fg(tokens.textSecondary)(`${found} found`)}  ${dim("\u00b7")}  ${fg(tokens.textMuted)(dirs)}`}
        wrapMode="none"
      />
      {pendingSizes > 0 ? (
        <text content={t`${fg(tokens.textMuted)(`${pendingSizes} sizing`)}`} wrapMode="none" />
      ) : null}
      {currentDir !== null ? (
        // ncdu's "current item" idiom - the path keeps moving even when the
        // counters stall, which is the proof-of-life a big tree needs.
        <text
          content={t` ${dim("\u00b7")}  ${fg(tokens.textDim)(tailPath(currentDir, 24))}`}
          wrapMode="none"
        />
      ) : null}
      {elapsedMs !== undefined && elapsedMs >= 250 ? (
        <text
          content={t` ${dim("\u00b7")}  ${fg(tokens.textDim)(formatElapsed(elapsedMs))}`}
          wrapMode="none"
        />
      ) : null}
      {skippedDirs > 0 ? (
        // Unreadable/cycled dirs mean the result set is partial - that must be
        // visible, not quietly absorbed into a total.
        <text
          content={t` ${dim("\u00b7")}  ${fg(tokens.warning)(`${skippedDirs} skipped`)}`}
          wrapMode="none"
        />
      ) : null}
      {orderPinned ? (
        // Sizes arrive after discovery, so the list is held in discovery order
        // until the scan ends. Say so, or it just looks unsorted.
        <text
          content={t` ${dim("\u00b7")}  ${fg(tokens.textDim)(`found order \u00b7 sorts when done`)}`}
          wrapMode="none"
        />
      ) : null}
    </box>
  );
}
