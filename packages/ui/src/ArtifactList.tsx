import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import type { BoxRenderable, MouseEvent } from "@opentui/core";
import type { BoxProps } from "@opentui/react";
import { useTerminalDimensions } from "@opentui/react";
import { MacOSScrollAccel } from "@opentui/core";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  artifactRowWidths,
  buildArtifactRowContent,
  buildGroupHeaderContent,
  buildListColumnHeader,
  buildListRule,
  type RowMetrics,
  type RowWidths,
} from "./presentation.js";
import type { UiDisplayRow } from "./rows.js";
import { owningHeaderIndex } from "./rows.js";
import { nextScrollTop } from "./scroll.js";
import { ScrollbarColumn, scrollbarModel } from "./ScrollbarColumn.js";
import type { ThemeTokens } from "./theme.js";

export interface ArtifactListProps {
  rows: UiDisplayRow[];
  candidatesById: Map<string, ScanCandidate>;
  selectedIds: Set<string>;
  currentRowIndex: number;
  /** Rows (inclusive) covered by the visual-mode range, or null. */
  visualRange?: { from: number; to: number } | null;
  focused: boolean;
  tokens: ThemeTokens;
  paneWidth?: number;
  targetDir?: string;
  onToggleSelection?: (candidateId: string) => void;
  onToggleGroup?: (groupKey: string) => void;
  onSetCursor?: (rowIndex: number) => void;
  /** Wheel input moves the cursor by this many item rows. */
  onCursorDelta?: (delta: number) => void;
  /** Reports the measured viewport height so pageup/pagedown can step a real page. */
  onViewportRows?: ((rows: number) => void) | undefined;
}

/**
 * Windowed artifact list.
 *
 * React only ever sees the rows that fit in the pane, so render cost is
 * O(viewport) rather than O(artifacts). The wheel moves the cursor, not a
 * detached viewport, so `space` always acts on a row that is on screen. The
 * scrollbar is a real track: click or drag it to seek the list.
 */
export function ArtifactList({
  rows,
  candidatesById,
  selectedIds,
  currentRowIndex,
  visualRange,
  focused,
  tokens,
  paneWidth,
  targetDir,
  onToggleSelection,
  onToggleGroup,
  onSetCursor,
  onCursorDelta,
  onViewportRows,
}: ArtifactListProps) {
  const listRef = useRef<BoxRenderable | null>(null);
  const [hoveredRowIndex, setHoveredRowIndex] = useState<number | null>(null);
  const dimensions = useTerminalDimensions();

  // Pane padding + borders + scrollbar consume columns; size rows off what remains.
  const listWidth = Math.max(
    36,
    (paneWidth ?? Math.max(36, dimensions.width - (dimensions.width >= 72 ? 36 : 6))) - 2,
  );
  const widths = useMemo(() => artifactRowWidths(listWidth), [listWidth]);
  // Age and size bars are relative to what is listed, and only change when the
  // rows do, so the memoised rows below are not invalidated by a keystroke.
  const metrics = useMemo<RowMetrics>(() => {
    let maxBytes = 0;
    for (const row of rows) {
      if (row.kind !== "item") continue;
      maxBytes = Math.max(maxBytes, candidatesById.get(row.candidateId)?.estimatedBytes ?? 0);
    }
    return { now: Date.now(), maxBytes };
  }, [rows, candidatesById]);

  /**
   * Rows the pane can show at once. Seeded from the terminal size so the first
   * frame is not blank, then kept exact by the layout event; a stale estimate
   * is safe either way because the container clips what the slice overshoots.
   */
  const [viewportHeight, setViewportHeight] = useState(() => Math.max(1, dimensions.height - 9));

  // cmdk "nearest": scroll only when the cursor would leave the viewport.
  // The window position is derived state - a ref records where the last
  // committed window started, and each render recomputes from it. No render-
  // phase setState: the cursor row is always inside the painted window, and
  // React never has a scheduled update pending (which also keeps the test
  // renderer's visual-idle check satisfied).
  const scrollTopRef = useRef(0);
  const maxScrollTop = Math.max(0, rows.length - viewportHeight);
  const appliedTop = Math.min(
    Math.max(0, nextScrollTop(scrollTopRef.current, viewportHeight, currentRowIndex)),
    maxScrollTop,
  );
  useEffect(() => {
    scrollTopRef.current = appliedTop;
  });

  const visibleRows = useMemo(
    () => rows.slice(appliedTop, appliedTop + viewportHeight),
    [rows, appliedTop, viewportHeight],
  );

  // Sticky group header (hunk/git-status style): while the cursor sits inside
  // a group whose own header has scrolled off the top, pin that header's line
  // under the column header so the scope of every visible row stays named.
  // When the real header is inside the window it renders in place and this
  // line disappears - the handoff is at most a one-line pop.
  const stickyHeader = useMemo(() => {
    const first = rows[appliedTop];
    if (!first || first.kind === "header") return null;
    const ownerIndex = owningHeaderIndex(rows, appliedTop);
    if (ownerIndex < 0 || ownerIndex >= appliedTop) return null;
    const owner = rows[ownerIndex];
    return owner?.kind === "header" ? owner : null;
  }, [rows, appliedTop]);

  // The sticky slot must not toggle layout. If the line mounted only when a
  // sticky header was active, the list below would shrink by one row exactly
  // when the window needs it most - near the list end the new height can pull
  // the owning header back into view, unmounting the slot, restoring the row,
  // and looping forever (this was the scroll flicker). Reserving the line
  // whenever the list can scroll makes the condition monotone: the slot only
  // ever shrinks the viewport, so a scrollable list stays scrollable.
  const reserveStickyRow = rows.length > viewportHeight;

  // While the window is sliding under a static pointer, OpenTUI's post-render
  // hit-test re-fires `over` on whatever row lands under it each frame - letting
  // that set hover state means a React dispatch (and a row tint chasing the
  // scroll) on every scroll frame. Freeze hover-set briefly after wheel input;
  // `out` still clears, so nothing gets stuck.
  const lastWheelAtRef = useRef(0);
  // macOS-style acceleration: a relaxed notch stays a precise ~3 rows while a
  // sustained flick ramps to ~3x, so fast scrubbing doesn't feel like wading.
  // The instance self-resets after a ~150ms idle gap (streakTimeout), no
  // manual reset needed.
  const wheelAccelRef = useRef<MacOSScrollAccel | null>(null);

  const handleHover = useCallback((index: number, hovered: boolean) => {
    if (hovered && Date.now() - lastWheelAtRef.current < 120) return;
    setHoveredRowIndex((prev) => (hovered ? index : prev === index ? null : prev));
  }, []);

  // The hovered index is meaningless across a row-set change (same index, new
  // row): filters, collapses, and scan upserts clear it rather than paint a
  // hover tint on a row the pointer never touched.
  useEffect(() => {
    setHoveredRowIndex(null);
  }, [rows]);

  const handleSizeChange = useCallback(() => {
    const height = listRef.current?.height;
    if (height !== undefined && height > 0) {
      setViewportHeight((current) => (current === height ? current : height));
      onViewportRows?.(height);
    }
  }, [onViewportRows]);

  const handleWheel = useCallback(
    (event: MouseEvent) => {
      const direction = event.scroll?.direction;
      if (direction !== "up" && direction !== "down") return;
      lastWheelAtRef.current = Date.now();
      const accel = (wheelAccelRef.current ??= new MacOSScrollAccel());
      // tick() returns the streak multiplier: ~1 relaxed, up to ~3 on a fast
      // flick - times the 3-row base step, capped so aggregated terminals
      // can't slingshot the cursor to the end.
      const multiplier = Math.min(4, accel.tick());
      const delta = Math.max(1, Math.round(multiplier * 3));
      onCursorDelta?.(direction === "up" ? -delta : delta);
    },
    [onCursorDelta],
  );

  const scrollbar = useMemo(
    () => scrollbarModel(rows.length, viewportHeight, appliedTop),
    [rows.length, viewportHeight, appliedTop],
  );

  return (
    <box width="100%" flexGrow={1} minHeight={0} flexDirection="column" onMouseScroll={handleWheel}>
      <box width="100%" flexShrink={0} flexDirection="column">
        <text content={buildListColumnHeader(widths, tokens)} wrapMode="none" />
        <text content={buildListRule(widths, tokens)} wrapMode="none" />
        {reserveStickyRow ? (
          <box width="100%" height={1} flexShrink={0} overflow="hidden">
            {stickyHeader ? (
              <text
                content={buildGroupHeaderContent(stickyHeader, tokens, widths)}
                wrapMode="none"
              />
            ) : (
              <text content=" " wrapMode="none" />
            )}
          </box>
        ) : null}
      </box>
      <box width="100%" flexGrow={1} minHeight={0} flexDirection="row">
        <box
          ref={listRef}
          width="100%"
          flexGrow={1}
          minHeight={0}
          flexDirection="column"
          overflow="hidden"
          onSizeChange={handleSizeChange}
        >
          {visibleRows.map((row, offset) => {
            const index = appliedTop + offset;
            const isCurrent = index === currentRowIndex;
            const isHovered = hoveredRowIndex === index && !isCurrent;

            if (row.kind === "header") {
              return (
                <HeaderRow
                  key={`header-${row.groupKey}`}
                  row={row}
                  index={index}
                  isCurrent={isCurrent}
                  isHovered={isHovered}
                  focused={focused}
                  widths={widths}
                  tokens={tokens}
                  onSetCursor={onSetCursor}
                  onToggleGroup={onToggleGroup}
                />
              );
            }

            const candidate = candidatesById.get(row.candidateId);
            if (!candidate) {
              return (
                <box
                  key={`missing-${row.candidateId}`}
                  width="100%"
                  height={1}
                  flexGrow={0}
                  flexShrink={0}
                />
              );
            }

            return (
              <ItemRow
                key={row.candidateId}
                candidate={candidate}
                index={index}
                isSelected={selectedIds.has(candidate.id)}
                isCurrent={isCurrent}
                inVisualRange={
                  visualRange ? index >= visualRange.from && index <= visualRange.to : false
                }
                focused={focused}
                isHovered={isHovered}
                widths={widths}
                metrics={metrics}
                tokens={tokens}
                targetDir={targetDir}
                groupLabel={row.groupLabel}
                onSetCursor={onSetCursor}
                onToggleSelection={onToggleSelection}
                onHover={handleHover}
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
    </box>
  );
}

interface HeaderRowProps {
  row: Extract<UiDisplayRow, { kind: "header" }>;
  index: number;
  isCurrent: boolean;
  isHovered: boolean;
  focused: boolean;
  widths: RowWidths;
  tokens: ThemeTokens;
  onSetCursor?: ((rowIndex: number) => void) | undefined;
  onToggleGroup?: ((groupKey: string) => void) | undefined;
}

const HeaderRow = memo(function HeaderRow({
  row,
  index,
  isCurrent,
  isHovered,
  focused,
  widths,
  tokens,
  onSetCursor,
  onToggleGroup,
}: HeaderRowProps) {
  const rowBg = isCurrent
    ? focused
      ? tokens.selectionBg
      : tokens.selectionSoftBg
    : isHovered
      ? tokens.hoverBg
      : undefined;

  return (
    <box
      width="100%"
      height={1}
      flexGrow={0}
      flexShrink={0}
      overflow="hidden"
      {...(rowBg ? { backgroundColor: rowBg } : {})}
      onMouseDown={() => {
        onToggleGroup?.(row.groupKey);
        onSetCursor?.(index);
      }}
    >
      <text content={buildGroupHeaderContent(row, tokens, widths)} wrapMode="none" />
    </box>
  );
});

interface ItemRowProps {
  candidate: ScanCandidate;
  index: number;
  isSelected: boolean;
  isCurrent: boolean;
  inVisualRange: boolean;
  focused: boolean;
  isHovered: boolean;
  widths: RowWidths;
  metrics: RowMetrics;
  tokens: ThemeTokens;
  targetDir?: string | undefined;
  /** Owning group's label - the parent path is hidden when it repeats it. */
  groupLabel?: string | undefined;
  onSetCursor?: ((rowIndex: number) => void) | undefined;
  onToggleSelection?: ((candidateId: string) => void) | undefined;
  onHover: (index: number, hovered: boolean) => void;
}

/**
 * Memoised so a keystroke repaints the two rows whose highlight changed rather
 * than every visible row; with windowing there are never more than a pane's
 * worth of rows mounted in the first place.
 */
const ItemRow = memo(function ItemRow({
  candidate,
  index,
  isSelected,
  isCurrent,
  inVisualRange,
  focused,
  isHovered,
  widths,
  metrics,
  tokens,
  targetDir,
  groupLabel,
  onSetCursor,
  onToggleSelection,
  onHover,
}: ItemRowProps) {
  const rowBg = isCurrent
    ? focused
      ? tokens.selectionBg
      : tokens.selectionSoftBg
    : inVisualRange
      ? tokens.selectionSoftBg
      : isHovered
        ? tokens.hoverBg
        : undefined;

  const mouseProps = {
    selectable: true,
    // `over`/`out` fire both on real pointer moves and when a repaint slides
    // content under a static pointer (OpenTUI re-hit-tests dirty grids) - that
    // second path is what keeps hover correct while scrolling. There is no
    // `onMouseLeave` event in OpenTUI; `out` is it.
    onMouseOver: () => onHover(index, true),
    onMouseMove: () => onHover(index, true),
    onMouseOut: () => onHover(index, false),
    // First click moves the cursor; clicking the focused row toggles it.
    onMouseDown: () => {
      if (isCurrent) {
        onToggleSelection?.(candidate.id);
      } else {
        onSetCursor?.(index);
      }
    },
  } as BoxProps;

  return (
    <box
      width="100%"
      height={1}
      flexGrow={0}
      flexShrink={0}
      overflow="hidden"
      flexDirection="row"
      {...(rowBg ? { backgroundColor: rowBg } : {})}
      {...mouseProps}
    >
      <text
        content={buildArtifactRowContent(
          candidate,
          isSelected,
          isCurrent,
          widths,
          tokens,
          targetDir,
          groupLabel,
          metrics,
        )}
        wrapMode="none"
      />
    </box>
  );
});
