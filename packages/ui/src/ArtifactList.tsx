import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { BoxProps } from "@opentui/react";
import { useTerminalDimensions } from "@opentui/react";
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
}

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
}: ArtifactListProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [hoveredRowIndex, setHoveredRowIndex] = useState<number | null>(null);
  const dimensions = useTerminalDimensions();

  // Pane padding + borders + scrollbar consume columns; size rows off what remains.
  const listWidth = Math.max(
    36,
    (paneWidth ?? Math.max(36, dimensions.width - (dimensions.width >= 72 ? 36 : 6))) - 2,
  );
  const widths = useMemo(() => artifactRowWidths(listWidth), [listWidth]);

  useEffect(() => {
    if (!focused) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    // cmdk "nearest": move the viewport only when the cursor would leave it.
    // scrollChildIntoView recenters and fights stickyScroll, which is the jitter.
    scroll.scrollTop = nextScrollTop(scroll.scrollTop, scroll.viewport.height, currentRowIndex);
  }, [currentRowIndex, focused, rows.length]);

  const handleHover = useCallback((index: number, hovered: boolean) => {
    setHoveredRowIndex((prev) => (hovered ? index : prev === index ? null : prev));
  }, []);

  return (
    <box width="100%" flexGrow={1} minHeight={0} flexDirection="column">
      <box width="100%" flexShrink={0} flexDirection="column">
        <text content={buildListColumnHeader(widths, tokens)} wrapMode="none" />
        <text content={buildListRule(widths, tokens)} wrapMode="none" />
      </box>
      <scrollbox
        ref={scrollRef}
        focused={focused}
        flexGrow={1}
        minHeight={0}
        width="100%"
        stickyScroll={false}
        scrollX={false}
        contentOptions={{ flexGrow: 0, flexShrink: 0 }}
        verticalScrollbarOptions={{
          trackOptions: { backgroundColor: tokens.surfaceInset, foregroundColor: tokens.border },
        }}
      >
        {rows.map((row, index) => {
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
              isHovered={isHovered}
              widths={widths}
              tokens={tokens}
              targetDir={targetDir}
              onSetCursor={onSetCursor}
              onToggleSelection={onToggleSelection}
              onHover={handleHover}
            />
          );
        })}
      </scrollbox>
    </box>
  );
}

interface HeaderRowProps {
  row: Extract<UiDisplayRow, { kind: "header" }>;
  index: number;
  isCurrent: boolean;
  isHovered: boolean;
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
  widths,
  tokens,
  onSetCursor,
  onToggleGroup,
}: HeaderRowProps) {
  const rowBg = isCurrent ? tokens.selectionBg : isHovered ? tokens.hoverBg : undefined;

  return (
    <box
      width="100%"
      height={1}
      flexGrow={0}
      flexShrink={0}
      overflow="hidden"
      {...(rowBg ? { backgroundColor: rowBg } : {})}
      onMouseDown={() => {
        onSetCursor?.(index);
        onToggleGroup?.(row.groupKey);
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
  isHovered: boolean;
  widths: RowWidths;
  tokens: ThemeTokens;
  targetDir?: string | undefined;
  onSetCursor?: ((rowIndex: number) => void) | undefined;
  onToggleSelection?: ((candidateId: string) => void) | undefined;
  onHover: (index: number, hovered: boolean) => void;
}

/**
 * Memoised so a keystroke repaints the two rows whose highlight changed rather
 * than every row in the list. At ~900 rows that is the difference between
 * smooth arrow keys and visible lag.
 */
const ItemRow = memo(function ItemRow({
  candidate,
  index,
  isSelected,
  isCurrent,
  isHovered,
  widths,
  tokens,
  targetDir,
  onSetCursor,
  onToggleSelection,
  onHover,
}: ItemRowProps) {
  const rowBg = isCurrent ? tokens.selectionBg : isHovered ? tokens.hoverBg : undefined;

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
        )}
        wrapMode="none"
      />
    </box>
  );
});
