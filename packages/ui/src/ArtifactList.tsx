import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { BoxProps } from "@opentui/react";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  artifactRowWidths,
  buildArtifactRowContent,
  buildGroupHeaderContent,
  buildListColumnHeader,
  buildListLegend,
  buildListRule,
} from "./presentation.js";
import type { UiDisplayRow } from "./rows.js";
import type { ThemeTokens } from "./theme.js";

export interface ArtifactListProps {
  rows: UiDisplayRow[];
  candidatesById: Map<string, ScanCandidate>;
  selectedIds: Set<string>;
  currentRowIndex: number;
  focused: boolean;
  tokens: ThemeTokens;
  paneWidth?: number;
  scanning?: boolean;
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
  scanning,
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
    try {
      scroll.scrollChildIntoView(`artifact-row-${currentRowIndex}`);
    } catch {
      // ignore if child row is not mounted yet during filter transitions
    }
  }, [currentRowIndex, focused]);

  return (
    <box width="100%" flexGrow={1} minHeight={0} flexDirection="column">
      <box width="100%" flexShrink={0} flexDirection="column">
        <text content={buildListColumnHeader(widths, tokens)} />
        <text content={buildListRule(widths, tokens)} />
        <text content={buildListLegend(tokens)} />
      </box>
      <scrollbox
        ref={scrollRef}
        focused={focused}
        flexGrow={1}
        width="100%"
        height="100%"
        viewportCulling
        verticalScrollbarOptions={{
          trackOptions: { backgroundColor: tokens.surfaceInset, foregroundColor: tokens.border },
        }}
      >
        {rows.map((row, index) => {
          if (row.kind === "header") {
            return (
              <box
                key={`header-${row.groupKey}-${index}`}
                id={`artifact-row-${index}`}
                width="100%"
                height={1}
                onMouseDown={() => onToggleGroup?.(row.groupKey)}
              >
                <text content={buildGroupHeaderContent(row, tokens, widths.nameWidth + 8)} />
              </box>
            );
          }

          const candidate = candidatesById.get(row.candidateId);
          if (!candidate) return null;

          const isCurrent = index === currentRowIndex;
          const isSelected = selectedIds.has(candidate.id);
          const isHovered = hoveredRowIndex === index && !isCurrent;
          const rowBg = isCurrent ? tokens.selectionBg : isHovered ? tokens.hoverBg : undefined;

          const mouseProps = {
            selectable: true,
            onMouseMove: () => setHoveredRowIndex(index),
            onMouseLeave: () => setHoveredRowIndex((prev) => (prev === index ? null : prev)),
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
              key={row.candidateId}
              id={`artifact-row-${index}`}
              width="100%"
              height={1}
              flexDirection="row"
              {...(rowBg ? { backgroundColor: rowBg } : {})}
              {...mouseProps}
            >
              <text
                content={buildArtifactRowContent(candidate, isSelected, isCurrent, widths, tokens)}
              />
            </box>
          );
        })}
        {scanning ? (
          <box width="100%" height={1} paddingTop={0}>
            <text content="  discovering more artifacts…" fg={tokens.textMuted} />
          </box>
        ) : null}
      </scrollbox>
    </box>
  );
}
