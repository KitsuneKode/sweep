import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { bold, fg, t } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { SelectableRow, useHoverState } from "./SelectableRow.js";
import { allocateBarCells, buildInsights, STALE_AFTER_DAYS, type Insights } from "./insights.js";
import {
  buildMeter,
  buildSidebarLine,
  concatStyled,
  riskGlyph,
  type ScopeRowState,
} from "./presentation.js";
import { isScopeAncestor } from "./scope-tree.js";
import {
  buildScopeSidebarRows,
  compactBytesLabel,
  scopeFilterToSidebarIndex,
  sidebarBytesWidth,
  sidebarColumnLayout,
  sidebarCountWidth,
  type ScopeSidebarRow,
} from "./sidebar.js";
import { nextScrollTop } from "./scroll.js";
import type { SweepUiState } from "./state.js";
import { riskColor, type ThemeTokens } from "./theme.js";
import { buildTreeGuides } from "./tree-line.js";

export interface ScopeSidebarProps {
  state: SweepUiState;
  tokens: ThemeTokens;
  focused: boolean;
  /** Inner content width of the sidebar pane (already minus borders/padding). */
  paneWidth: number;
  onApplyScope: (scopeFilter: string | null) => void;
  /** Wheel input moves the sidebar cursor by this many rows. */
  onCursorDelta?: (delta: number) => void;
}

export function ScopeSidebar({
  state,
  tokens,
  focused,
  paneWidth,
  onApplyScope,
  onCursorDelta,
}: ScopeSidebarProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const { isHovered, onHoverChange } = useHoverState<number>();

  const rows = useMemo(
    () =>
      buildScopeSidebarRows(
        state.targetDir,
        state.candidates,
        state.selectedIds,
        state.expandedScopes,
      ),
    [state.targetDir, state.candidates, state.selectedIds, state.expandedScopes],
  );

  const guides = useMemo(() => buildTreeGuides(rows), [rows]);
  const countWidth = useMemo(() => sidebarCountWidth(rows), [rows]);
  const bytesWidth = useMemo(() => sidebarBytesWidth(rows), [rows]);
  const totalBytes = rows[0]?.bytes ?? 0;
  const selectedBytes = rows[0]?.selectedBytes ?? 0;
  const cursorIndex = focused
    ? state.sidebarIndex
    : scopeFilterToSidebarIndex(state.scopeFilter, rows);

  useEffect(() => {
    if (!focused) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollTop = nextScrollTop(scroll.scrollTop, scroll.viewport.height, cursorIndex);
  }, [cursorIndex, focused]);

  const meterWidth = Math.max(10, paneWidth - 4);
  const { height: screenHeight } = useTerminalDimensions();
  // The insights panel is garnish: it yields to the scope list on short terminals.
  const showInsights = screenHeight >= INSIGHTS_MIN_SCREEN_HEIGHT;
  const insights = useMemo(
    () => (showInsights ? buildInsights(state.candidates, Date.now()) : null),
    [showInsights, state.candidates],
  );

  // Wheel must move the cursor, not the viewport - the scrollbox scrolling on
  // its own left the cursor pointed at a row that was no longer visible, so
  // `enter` applied a scope the user was not looking at. stopPropagation keeps
  // the event from ever reaching the scrollbox's own scroll handler.
  const handleWheel = useCallback(
    (event: MouseEvent) => {
      const direction = event.scroll?.direction;
      if (direction !== "up" && direction !== "down") return;
      event.stopPropagation();
      const delta = Math.max(1, Math.abs(event.scroll?.delta ?? 1)) * 3;
      onCursorDelta?.(direction === "up" ? -delta : delta);
    },
    [onCursorDelta],
  );

  return (
    <box width="100%" flexGrow={1} minHeight={0} flexDirection="column">
      <ReclaimPanel
        tokens={tokens}
        selectedBytes={selectedBytes}
        totalBytes={totalBytes}
        width={meterWidth}
      />
      <scrollbox
        ref={scrollRef}
        // Never focused: cursor keys belong to the app keymap alone. Giving
        // the scrollbox a second set of scroll keys made arrows move the view
        // and the cursor in different amounts.
        focusable={false}
        flexGrow={1}
        minHeight={3}
        width="100%"
        stickyScroll={false}
        scrollX={false}
        contentOptions={{ flexGrow: 0 }}
      >
        <box width="100%" flexDirection="column" onMouseScroll={handleWheel}>
          {rows.map((row, index) => (
            <ScopeRow
              key={row.key ?? "__all__"}
              row={row}
              guide={guides[index] ?? ""}
              rowState={scopeRowState(row, state, index, cursorIndex, focused)}
              isCursor={index === cursorIndex && focused}
              hovered={isHovered(index)}
              expanded={row.key !== null && state.expandedScopes.has(row.key)}
              layout={sidebarColumnLayout(paneWidth, countWidth, bytesWidth, row.depth)}
              tokens={tokens}
              onSelect={() => onApplyScope(row.key)}
              onHoverChange={onHoverChange(index)}
            />
          ))}
        </box>
      </scrollbox>
      {insights && insights.tiers.length > 0 ? (
        <InsightsPanel tokens={tokens} insights={insights} width={meterWidth} />
      ) : null}
    </box>
  );
}

/** Below this terminal height the scope list keeps the whole sidebar. */
const INSIGHTS_MIN_SCREEN_HEIGHT = 26;

function scopeRowState(
  row: ScopeSidebarRow,
  state: SweepUiState,
  index: number,
  cursorIndex: number,
  focused: boolean,
): ScopeRowState {
  const isActive =
    state.scopeFilter === row.key || (state.scopeFilter === null && row.key === null);
  if (isActive) return "active";
  if (isScopeAncestor(row.key, state.scopeFilter)) return "ancestor";
  if (focused && index === cursorIndex) return "cursor";
  return "idle";
}

interface ScopeRowProps {
  row: ScopeSidebarRow;
  guide: string;
  rowState: ScopeRowState;
  isCursor: boolean;
  hovered: boolean;
  expanded: boolean;
  layout: ReturnType<typeof sidebarColumnLayout>;
  tokens: ThemeTokens;
  onSelect: () => void;
  onHoverChange: (hovered: boolean) => void;
}

const ScopeRow = memo(function ScopeRow({
  row,
  guide,
  rowState,
  isCursor,
  hovered,
  expanded,
  layout,
  tokens,
  onSelect,
  onHoverChange,
}: ScopeRowProps) {
  const branch = row.hasChildren ? (expanded ? "▾" : "▸") : " ";

  return (
    <SelectableRow
      selected={isCursor}
      emphasized={rowState === "active"}
      hovered={hovered}
      tokens={tokens}
      onSelect={onSelect}
      onHoverChange={onHoverChange}
    >
      <box width="100%" height={1} flexGrow={0} flexShrink={0}>
        <text
          wrapMode="none"
          content={buildSidebarLine({
            label: row.label,
            count: row.count,
            bytes: row.bytes,
            selectedCount: row.selectedCount,
            state: rowState,
            guide,
            branch,
            countWidth: layout.countWidth,
            bytesWidth: layout.bytesWidth,
            maxLabelWidth: layout.maxLabelWidth,
            showBytes: layout.showBytes,
            tokens,
          })}
        />
      </box>
    </SelectableRow>
  );
});

function ReclaimPanel({
  tokens,
  selectedBytes,
  totalBytes,
  width,
}: {
  tokens: ThemeTokens;
  selectedBytes: number;
  totalBytes: number;
  width: number;
}) {
  const hasSelection = selectedBytes > 0 && totalBytes > 0;
  const percent = totalBytes > 0 ? Math.round((selectedBytes / totalBytes) * 100) : 0;
  const scanned = t`${fg(tokens.textDim)(`${compactBytesLabel(totalBytes)} found`)}`;

  if (!hasSelection) {
    return (
      <box
        width="100%"
        height={2}
        flexDirection="column"
        paddingLeft={1}
        backgroundColor={tokens.bg}
        flexShrink={0}
      >
        <text content={t`${bold(fg(tokens.textMuted)("nothing queued"))}`} wrapMode="none" />
        <text content={scanned} wrapMode="none" />
      </box>
    );
  }

  const percentLabel = `${String(percent).padStart(3, " ")}%`;
  const barWidth = Math.max(8, width - percentLabel.length - 1);

  return (
    <box
      width="100%"
      height={2}
      flexDirection="column"
      paddingLeft={1}
      backgroundColor={tokens.bg}
      flexShrink={0}
    >
      <text
        content={concatStyled(
          buildMeter(selectedBytes, totalBytes, barWidth, tokens),
          t` ${fg(tokens.positive)(percentLabel)}`,
        )}
        wrapMode="none"
      />
      <text
        content={t`${fg(tokens.positive)(compactBytesLabel(selectedBytes))} ${fg(tokens.textMuted)("queued of")} ${fg(tokens.textMuted)(compactBytesLabel(totalBytes))}`}
        wrapMode="none"
      />
    </box>
  );
}

const TIER_LABEL = {
  safe: "safe",
  caution: "caution",
  dangerous: "dangerous",
  blocked: "blocked",
} as const;

/**
 * What the scan found, by risk tier, and how much of it nobody has touched.
 * Read-only context for the queue meter above it: the meter says what will
 * go, this says what is out there.
 */
function InsightsPanel({
  tokens,
  insights,
  width,
}: {
  tokens: ThemeTokens;
  insights: Insights;
  width: number;
}) {
  const colors = riskColor(tokens);
  const cells = allocateBarCells(insights.tiers, width);
  const bar = concatStyled(
    ...insights.tiers.map(
      (entry, index) => t`${fg(colors[entry.tier])("█".repeat(cells[index] ?? 0))}`,
    ),
  );
  const labelWidth = Math.max(...insights.tiers.map((entry) => TIER_LABEL[entry.tier].length));
  const bytesWidth = Math.max(
    ...insights.tiers.map((entry) => compactBytesLabel(entry.bytes).length),
    compactBytesLabel(insights.stale.bytes).length,
  );
  const showStale = insights.ageKnown && insights.stale.count > 0;

  return (
    <box
      width="100%"
      flexDirection="column"
      paddingLeft={1}
      paddingTop={1}
      flexShrink={0}
      height={insights.tiers.length + 2 + (showStale ? 1 : 0) + 1}
    >
      <text content={bar} wrapMode="none" />
      {insights.tiers.map((entry) => (
        <text
          key={entry.tier}
          wrapMode="none"
          content={t`${fg(colors[entry.tier])(riskGlyph[entry.tier])} ${fg(tokens.textMuted)(TIER_LABEL[entry.tier].padEnd(labelWidth))} ${fg(tokens.textSecondary)(compactBytesLabel(entry.bytes).padStart(bytesWidth))}`}
        />
      ))}
      {showStale ? (
        <text
          wrapMode="none"
          content={t`${fg(tokens.textDim)(`untouched ${STALE_AFTER_DAYS}d+`)} ${fg(tokens.positive)(compactBytesLabel(insights.stale.bytes))}`}
        />
      ) : null}
    </box>
  );
}
