import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { BoxProps } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import {
  buildArtifactRowContent,
  buildGroupHeaderContent,
  buildListColumnHeader,
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
  onToggleSelection?: (candidateId: string) => void;
}

export function ArtifactList({
  rows,
  candidatesById,
  selectedIds,
  currentRowIndex,
  focused,
  tokens,
  onToggleSelection,
}: ArtifactListProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [hoveredRowIndex, setHoveredRowIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!focused) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollChildIntoView(`artifact-row-${currentRowIndex}`);
  }, [currentRowIndex, focused]);

  return (
    <scrollbox
      ref={scrollRef}
      focused={focused}
      flexGrow={1}
      width="100%"
      height="100%"
      viewportCulling
      verticalScrollbarOptions={{
        trackOptions: { backgroundColor: tokens.surfaceInset },
      }}
    >
      <box width="100%" paddingBottom={1}>
        <text content={buildListColumnHeader(tokens)} />
      </box>
      {rows.map((row, index) => {
        if (row.kind === "header") {
          return (
            <box
              key={`header-${row.groupKey}-${index}`}
              width="100%"
              paddingTop={index > 0 ? 1 : 0}
            >
              <text content={buildGroupHeaderContent(row, tokens)} />
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
          onMouseDown: () => onToggleSelection?.(candidate.id),
        } as BoxProps;

        return (
          <box
            key={row.candidateId}
            id={`artifact-row-${index}`}
            width="100%"
            {...(rowBg ? { backgroundColor: rowBg } : {})}
            {...mouseProps}
          >
            <text content={buildArtifactRowContent(candidate, isSelected, isCurrent, tokens)} />
          </box>
        );
      })}
    </scrollbox>
  );
}
