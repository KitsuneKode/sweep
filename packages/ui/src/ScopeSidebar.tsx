import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useMemo, useRef } from "react";
import { SelectableRow, useHoverState } from "./SelectableRow.js";
import { buildSidebarLine } from "./presentation.js";
import {
  buildScopeSidebarRows,
  scopeFilterToSidebarIndex,
  sidebarCountWidth,
  type ScopeSidebarRow,
} from "./sidebar.js";
import type { SweepUiState } from "./state.js";
import type { ThemeTokens } from "./theme.js";

export interface ScopeSidebarProps {
  state: SweepUiState;
  tokens: ThemeTokens;
  focused: boolean;
  onApplyScope: (scopeFilter: string | null) => void;
}

export function ScopeSidebar({ state, tokens, focused, onApplyScope }: ScopeSidebarProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const { isHovered, onHoverChange } = useHoverState<number>();

  const rows = useMemo(
    () => buildScopeSidebarRows(state.targetDir, state.candidates, state.selectedIds),
    [state.targetDir, state.candidates, state.selectedIds],
  );

  const countWidth = useMemo(() => sidebarCountWidth(rows), [rows]);
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

  return (
    <box width="100%" height="100%" flexDirection="column" gap={0}>
      <box width="100%" paddingBottom={1}>
        <text content="scopes" fg={tokens.textMuted} />
      </box>
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
                  content={buildSidebarLine(row.label, row.count, isActive, countWidth, tokens)}
                />
              </box>
            </SelectableRow>
          );
        })}
      </scrollbox>
    </box>
  );
}
