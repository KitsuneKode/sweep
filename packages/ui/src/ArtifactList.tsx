import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import type { BoxRenderable, MouseEvent } from "@opentui/core";
import type { BoxProps } from "@opentui/react";
import { useTerminalDimensions } from "@opentui/react";
import { fg, t } from "@opentui/core";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  artifactRowWidths,
  buildArtifactRowContent,
  buildGroupHeaderContent,
  buildListColumnHeader,
  buildListRule,
  type RowWidths,
} from "./presentation.js";
import type { UiDisplayRow } from "./rows.js";
import { owningHeaderIndex } from "./rows.js";
import { nextScrollTop } from "./scroll.js";
import type { ThemeTokens } from "./theme.js";

export interface ArtifactListProps {
  rows: UiDisplayRow[];
  candidatesById: Map<string, ScanCandidate>;
  selectedIds: Set<string>;
  currentRowIndex: number;
  focused: boolean;
  tokens: ThemeTokens;
  paneWidth?: number;
  targetDir?: string;
  onToggleSelection?: (candidateId: string) => void;
  onToggleGroup?: (groupKey: string) => void;
  onSetCursor?: (rowIndex: number) => void;
  /** Wheel input moves the cursor by this many item rows. */
  onCursorDelta?: (delta: number) => void;
}

/**
 * Windowed artifact list.
 *
 * The old version mounted every row into a ScrollBox and let OpenTUI cull the
 * paint — so a 600-artifact plan still paid React mount + layout cost for 600
 * renderables per keystroke, and the mouse wheel scrolled the viewport while
 * the cursor (and `space`) stayed pointed at a row that was no longer on
 * screen. This version owns the window: React only ever sees the rows that fit
 * in the pane, the wheel moves the *cursor* (so the view and the selection can
 * never diverge), and the scrollbar is a 1-column indicator, not an
 * interactive track.
 */
export function ArtifactList({
  rows,
  candidatesById,
  selectedIds,
  currentRowIndex,
  focused,
  tokens,
  paneWidth,
  targetDir,
  onToggleSelection,
  onToggleGroup,
  onSetCursor,
  onCursorDelta,
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

  /**
   * Rows the pane can show at once. Seeded from the terminal size so the first
   * frame is not blank, then kept exact by the layout event; a stale estimate
   * is safe either way because the container clips what the slice overshoots.
   */
  const [viewportHeight, setViewportHeight] = useState(() => Math.max(1, dimensions.height - 9));

  // cmdk "nearest": scroll only when the cursor would leave the viewport.
  // The window position is derived state — a ref records where the last
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
  // line disappears — the handoff is at most a one-line pop.
  const stickyHeader = useMemo(() => {
    const first = rows[appliedTop];
    if (!first || first.kind === "header") return null;
    const ownerIndex = owningHeaderIndex(rows, appliedTop);
    if (ownerIndex < 0 || ownerIndex >= appliedTop) return null;
    const owner = rows[ownerIndex];
    return owner?.kind === "header" ? owner : null;
  }, [rows, appliedTop]);

  const handleHover = useCallback((index: number, hovered: boolean) => {
    setHoveredRowIndex((prev) => (hovered ? index : prev === index ? null : prev));
  }, []);

  const handleSizeChange = useCallback(() => {
    const height = listRef.current?.height;
    if (height !== undefined && height > 0) {
      setViewportHeight((current) => (current === height ? current : height));
    }
  }, []);

  const handleWheel = useCallback(
    (event: MouseEvent) => {
      const direction = event.scroll?.direction;
      if (direction !== "up" && direction !== "down") return;
      // ~3 rows per notch, matching browser/terminal scroll convention. The
      // cursor moves — never the viewport alone — so space/enter always act on
      // a row the user can see.
      const delta = Math.max(1, Math.abs(event.scroll?.delta ?? 1)) * 3;
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
        {stickyHeader ? (
          <box width="100%" height={1} flexShrink={0} overflow="hidden">
            <text content={buildGroupHeaderContent(stickyHeader, tokens, widths)} wrapMode="none" />
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
                focused={focused}
                isHovered={isHovered}
                widths={widths}
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
          <ScrollbarColumn tokens={tokens} model={scrollbar} height={viewportHeight} />
        ) : null}
      </box>
    </box>
  );
}

interface ScrollbarModel {
  thumbTop: number;
  thumbHeight: number;
}

function scrollbarModel(
  rowCount: number,
  viewportHeight: number,
  scrollTop: number,
): ScrollbarModel | null {
  if (viewportHeight <= 0 || rowCount <= viewportHeight) return null;
  // Minimum 2 cells — a 1-cell thumb reads as a stray accent, not a position.
  const thumbHeight = Math.max(2, Math.round((viewportHeight * viewportHeight) / rowCount));
  const maxTop = Math.max(1, rowCount - viewportHeight);
  const thumbTop = Math.round((scrollTop / maxTop) * (viewportHeight - thumbHeight));
  return { thumbTop, thumbHeight };
}

/** Passive 1-column scrollbar: track shows there is more; thumb shows where. */
const ScrollbarColumn = memo(function ScrollbarColumn({
  tokens,
  model,
  height,
}: {
  tokens: ThemeTokens;
  model: ScrollbarModel;
  height: number;
}) {
  const lines = useMemo(() => {
    const cells: boolean[] = [];
    for (let i = 0; i < height; i++) {
      cells.push(i >= model.thumbTop && i < model.thumbTop + model.thumbHeight);
    }
    return cells;
  }, [model, height]);

  return (
    <box width={1} flexShrink={0} flexDirection="column" overflow="hidden">
      {lines.map((inThumb, index) => (
        <text
          key={`sb-${index}`}
          // "░" for the track so it reads as a lane, not a second pane border.
          content={t`${fg(inThumb ? tokens.accent : tokens.textDim)(inThumb ? "█" : "░")}`}
          wrapMode="none"
        />
      ))}
    </box>
  );
});

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
  focused: boolean;
  isHovered: boolean;
  widths: RowWidths;
  tokens: ThemeTokens;
  targetDir?: string | undefined;
  /** Owning group's label — the parent path is hidden when it repeats it. */
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
  focused,
  isHovered,
  widths,
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
    : isHovered
      ? tokens.hoverBg
      : undefined;

  const mouseProps = {
    selectable: true,
    onMouseMove: () => onHover(index, true),
    onMouseLeave: () => onHover(index, false),
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
        )}
        wrapMode="none"
      />
    </box>
  );
});
