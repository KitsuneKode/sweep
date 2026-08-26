import type { ScrollBoxRenderable } from "@opentui/core";
import { bold, dim, fg, t } from "@opentui/core";
import { useEffect, useMemo, useRef } from "react";
import { SelectableRow, useHoverState } from "./SelectableRow.js";
import { buildMeter, buildSidebarLine, concatStyled } from "./presentation.js";
import {
  buildScopeSidebarRows,
  compactBytesLabel,
  scopeFilterToSidebarIndex,
  sidebarBytesWidth,
  sidebarCountWidth,
  type ScopeSidebarRow,
} from "./sidebar.js";
import type { SweepUiState } from "./state.js";
import type { ThemeTokens } from "./theme.js";

export interface ScopeSidebarProps {
  state: SweepUiState;
  tokens: ThemeTokens;
  focused: boolean;
  /** Inner content width of the sidebar pane (already minus borders/padding). */
  paneWidth: number;
  onApplyScope: (scopeFilter: string | null) => void;
}

export function ScopeSidebar({
  state,
  tokens,
  focused,
  paneWidth,
  onApplyScope,
}: ScopeSidebarProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const { isHovered, onHoverChange } = useHoverState<number>();

  const rows = useMemo(
    () => buildScopeSidebarRows(state.targetDir, state.candidates, state.selectedIds),
    [state.targetDir, state.candidates, state.selectedIds],
  );

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
    scroll.scrollChildIntoView(`scope-row-${cursorIndex}`);
  }, [cursorIndex, focused]);

  const applyRow = (row: ScopeSidebarRow) => {
    onApplyScope(row.key);
  };

  const meterWidth = Math.max(10, paneWidth - 4);

  return (
    <box width="100%" flexGrow={1} minHeight={0} flexDirection="column">
      <ReclaimPanel
        tokens={tokens}
        selectedBytes={selectedBytes}
        totalBytes={totalBytes}
        width={meterWidth}
      />
      <scrollbox ref={scrollRef} focused={focused} flexGrow={1} minHeight={3} width="100%">
        {rows.map((row, index) => {
          const isCursor = index === cursorIndex && focused;
          const isActive =
            state.scopeFilter === row.key || (state.scopeFilter === null && row.key === null);

          return (
            <SelectableRow
              key={row.key ?? "__all__"}
              selected={isCursor}
              hovered={isHovered(index)}
              tokens={tokens}
              onSelect={() => applyRow(row)}
              onHoverChange={onHoverChange(index)}
            >
              <box id={`scope-row-${index}`} width="100%">
                <text
                  content={buildSidebarLine(
                    row.label,
                    row.count,
                    row.bytes,
                    isActive,
                    countWidth,
                    bytesWidth,
                    tokens,
                    row.selectedCount,
                  )}
                />
              </box>
            </SelectableRow>
          );
        })}
      </scrollbox>
    </box>
  );
}

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
  const percent = totalBytes > 0 ? Math.round((selectedBytes / totalBytes) * 100) : 0;
  const percentLabel = `${String(percent).padStart(3, " ")}%`;
  const barWidth = Math.max(8, width - percentLabel.length - 1);

  return (
    <box
      width="100%"
      height={3}
      flexDirection="column"
      paddingLeft={1}
      backgroundColor={tokens.bg}
      flexShrink={0}
    >
      <text content={t`${bold(fg(tokens.textMuted)("RECLAIM"))}`} />
      <text
        content={concatStyled(
          buildMeter(selectedBytes, totalBytes, barWidth, tokens),
          t` ${fg(tokens.textSecondary)(percentLabel)}`,
        )}
      />
      <text
        content={
          selectedBytes > 0
            ? t`${fg(tokens.positive)(compactBytesLabel(selectedBytes))} ${fg(tokens.textDim)("of")} ${fg(tokens.textMuted)(compactBytesLabel(totalBytes))}`
            : t`${fg(tokens.textDim)(`0 of ${compactBytesLabel(totalBytes)}`)}`
        }
      />
    </box>
  );
}
