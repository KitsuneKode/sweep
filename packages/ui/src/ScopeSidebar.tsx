import type { BoxRenderable, MouseEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { rowBackground, SelectableRow, useHoverState } from "./SelectableRow.js";
import { buildSidebarRow, type ScopeRowState, QUEUE_GLYPH, queueState } from "./presentation.js";
import { Meter, useKittyGraphics } from "./Meter.js";
import { isScopeAncestor } from "./scope-tree.js";
import {
  buildScopeSidebarRows,
  scopeFilterToSidebarIndex,
  sidebarBytesWidth,
  sidebarColumnLayout,
  sidebarCountWidth,
  sidebarHint,
  type ScopeSidebarRow,
} from "./sidebar.js";
import { nextScrollTop } from "./scroll.js";
import { ScrollbarColumn, scrollbarModel } from "./ScrollbarColumn.js";
import type { SweepUiState } from "./state.js";
import type { ThemeTokens } from "./theme.js";
import { buildTreeGuides } from "./tree-line.js";
import { ActionButton } from "./ActionButton.js";
import { cellWidth } from "./text-cells.js";

export interface ScopeSidebarProps {
  state: SweepUiState;
  tokens: ThemeTokens;
  focused: boolean;
  /** Inner content width of the sidebar pane (already minus borders/padding). */
  paneWidth: number;
  onApplyScope: (scopeFilter: string | null) => void;
  /** Wheel input moves the sidebar cursor by this many rows. */
  onCursorDelta?: (delta: number) => void;
  onSetCursor?: (index: number) => void;
  onToggleQueue?: (scope: string | null) => void;
  onToggleExpand?: (scope: string) => void;
}

export function ScopeSidebar({
  state,
  tokens,
  focused,
  paneWidth,
  onApplyScope,
  onCursorDelta,
  onSetCursor,
  onToggleQueue,
  onToggleExpand,
}: ScopeSidebarProps) {
  const listRef = useRef<BoxRenderable>(null);
  const rootRef = useRef<BoxRenderable>(null);
  const footerRef = useRef<BoxRenderable>(null);
  const { isHovered, onHoverChange } = useHoverState<string>();

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
  // Folder bars scale against the heaviest folder, not the grand total, so
  // the top entry fills its bar and the rest read as shares of it.
  const maxFolderBytes = useMemo(
    () => rows.reduce((max, row) => (row.key === null ? max : Math.max(max, row.bytes)), 0),
    [rows],
  );
  const cursorIndex = focused
    ? state.sidebarIndex
    : scopeFilterToSidebarIndex(state.scopeFilter, rows);

  const { height: screenHeight } = useTerminalDimensions();
  const [viewportHeight, setViewportHeight] = useState(() => Math.max(1, screenHeight - 10));
  const scrollTopRef = useRef(0);
  const appliedTop = Math.min(
    Math.max(0, nextScrollTop(scrollTopRef.current, viewportHeight, cursorIndex)),
    Math.max(0, rows.length - viewportHeight),
  );
  useEffect(() => {
    scrollTopRef.current = appliedTop;
  });
  const handleSizeChange = useCallback(() => {
    const height = listRef.current?.height;
    const root = rootRef.current;
    const list = listRef.current;
    if (height !== undefined && height > 0 && root && list) {
      const available = Math.max(
        1,
        root.y + root.height - (footerRef.current?.height ?? 0) - list.y,
      );
      const visible = Math.min(height, available);
      setViewportHeight((current) => (current === visible ? current : visible));
    }
  }, []);
  useLayoutEffect(handleSizeChange, [
    handleSizeChange,
    screenHeight,
    paneWidth,
    focused,
    rows.length,
  ]);
  const visibleRows = rows.slice(appliedTop, appliedTop + viewportHeight);
  const scrollbar = scrollbarModel(rows.length, viewportHeight, appliedTop);
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
    <box
      ref={rootRef}
      width="100%"
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
      onSizeChange={handleSizeChange}
    >
      <box
        flexGrow={1}
        flexBasis={0}
        flexShrink={1}
        minHeight={1}
        width="100%"
        flexDirection="row"
        onMouseScroll={handleWheel}
      >
        <box
          ref={listRef}
          flexGrow={1}
          minHeight={0}
          flexDirection="column"
          overflow="hidden"
          onSizeChange={handleSizeChange}
        >
          {visibleRows.map((row, offset) => {
            const index = appliedTop + offset;
            return (
              <ScopeRow
                key={row.key ?? "__all__"}
                row={row}
                guide={guides[index] ?? ""}
                rowState={scopeRowState(row, state, index, cursorIndex, focused)}
                isCursor={index === cursorIndex && focused}
                hovered={isHovered(row.key ?? "__all__")}
                expanded={row.key !== null && state.expandedScopes.has(row.key)}
                maxBytes={row.key === null ? 0 : maxFolderBytes}
                layout={sidebarColumnLayout(
                  paneWidth - 3 - (scrollbar ? 1 : 0),
                  countWidth,
                  bytesWidth,
                  row.depth,
                )}
                tokens={tokens}
                onSelect={() => onApplyScope(row.key)}
                onToggleQueue={onToggleQueue ? () => onToggleQueue(row.key) : undefined}
                onToggleExpand={
                  row.key !== null && onToggleExpand ? () => onToggleExpand(row.key!) : undefined
                }
                onHoverChange={onHoverChange(row.key ?? "__all__")}
              />
            );
          })}
        </box>
        {scrollbar ? (
          <ScrollbarColumn
            tokens={tokens}
            model={scrollbar}
            height={viewportHeight}
            rowCount={rows.length}
            onSeek={onSetCursor}
          />
        ) : null}
      </box>
      <box ref={footerRef} flexShrink={0} height={1}>
        <text content={sidebarHint(focused, paneWidth)} fg={tokens.textDim} wrapMode="none" />
      </box>
    </box>
  );
}

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
  maxBytes: number;
  tokens: ThemeTokens;
  onSelect: () => void;
  onHoverChange: (hovered: boolean) => void;
  onToggleQueue?: (() => void) | undefined;
  onToggleExpand?: (() => void) | undefined;
}

const ScopeRow = memo(function ScopeRow({
  row,
  guide,
  rowState,
  isCursor,
  hovered,
  expanded,
  layout,
  maxBytes,
  tokens,
  onSelect,
  onHoverChange,
  onToggleQueue,
  onToggleExpand,
}: ScopeRowProps) {
  const rowRef = useRef<BoxRenderable | null>(null);
  const branch = row.hasChildren ? (expanded ? "▾" : "▸") : " ";
  const kitty = useKittyGraphics();
  const line = buildSidebarRow({
    label: row.key === null ? "All folders" : row.key === "" ? "Target root" : row.label,
    count: row.count,
    bytes: row.bytes,
    selectedCount: row.selectedCount,
    state: rowState,
    guide,
    branch,
    markActive: false,
    countWidth: layout.countWidth,
    bytesWidth: layout.bytesWidth,
    maxLabelWidth: layout.maxLabelWidth,
    showBytes: layout.showBytes,
    barWidth: layout.barWidth,
    maxBytes,
    tokens,
    barGap: kitty,
  });

  return (
    <SelectableRow
      selected={isCursor}
      emphasized={rowState === "active"}
      hovered={hovered}
      tokens={tokens}
      elementRef={rowRef}
      onSelect={(event) => {
        const arrowX = (rowRef.current?.x ?? 0) + 3 + cellWidth(guide);
        if (event && row.hasChildren && event.x === arrowX && onToggleExpand) onToggleExpand();
        else onSelect();
      }}
      onHoverChange={onHoverChange}
    >
      <box width="100%" height={1} flexGrow={0} flexShrink={0} flexDirection="row">
        <ActionButton
          label={QUEUE_GLYPH[queueState(row.selectedCount, row.count)]}
          color={
            {
              none: tokens.textDim,
              some: tokens.textSecondary,
              all: tokens.accent,
            }[queueState(row.selectedCount, row.count)]
          }
          tokens={tokens}
          framed={false}
          disabled={!onToggleQueue || row.count === 0}
          onPress={() => onToggleQueue?.()}
        />
        <text content={rowState === "active" ? " ›" : "  "} fg={tokens.accent} />
        <box flexGrow={1} minWidth={0}>
          <text wrapMode="none" content={line.content} />
          {line.bar ? (
            <box
              position="absolute"
              left={line.bar.column}
              top={0}
              width={line.bar.width}
              height={1}
            >
              <Meter
                width={line.bar.width}
                value={line.bar.fraction}
                fill={line.bar.color}
                previewColor={line.bar.color}
                track={null}
                animate={false}
                variant="blocks"
                thickness={0.42}
                background={
                  rowBackground(isCursor, rowState === "active", hovered, tokens) ?? tokens.bg
                }
              />
            </box>
          ) : null}
        </box>
      </box>
    </SelectableRow>
  );
});
