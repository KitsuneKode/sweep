import type { ScrollBoxRenderable } from "@opentui/core";
import { bold, fg, t } from "@opentui/core";
import { memo, useEffect, useMemo, useRef } from "react";
import { SelectableRow, useHoverState } from "./SelectableRow.js";
import { buildMeter, buildSidebarLine, concatStyled, type ScopeRowState } from "./presentation.js";
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
import type { ThemeTokens } from "./theme.js";
import { buildTreeGuides } from "./tree-line.js";

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
  const totalCount = rows[0]?.count ?? 0;
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

  return (
    <box width="100%" flexGrow={1} minHeight={0} flexDirection="column">
      <ReclaimPanel
        tokens={tokens}
        selectedBytes={selectedBytes}
        totalBytes={totalBytes}
        totalCount={totalCount}
        width={meterWidth}
      />
      <scrollbox
        ref={scrollRef}
        focused={focused}
        flexGrow={1}
        minHeight={3}
        width="100%"
        stickyScroll={false}
        scrollX={false}
        contentOptions={{ flexGrow: 0 }}
      >
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
      </scrollbox>
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
  totalCount,
  width,
}: {
  tokens: ThemeTokens;
  selectedBytes: number;
  totalBytes: number;
  totalCount: number;
  width: number;
}) {
  const hasSelection = selectedBytes > 0 && totalBytes > 0;
  const percent = totalBytes > 0 ? Math.round((selectedBytes / totalBytes) * 100) : 0;
  const scanned = t`${fg(tokens.textDim)(compactBytesLabel(totalBytes))} ${fg(tokens.textDim)("·")} ${fg(tokens.textDim)(String(totalCount))}`;

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
        <text content={t`${bold(fg(tokens.textMuted)("queue"))}`} wrapMode="none" />
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
        content={t`${fg(tokens.positive)(compactBytesLabel(selectedBytes))} ${fg(tokens.textDim)("of")} ${fg(tokens.textMuted)(compactBytesLabel(totalBytes))}`}
        wrapMode="none"
      />
    </box>
  );
}
