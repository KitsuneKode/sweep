import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import type { BoxRenderable, MouseEvent } from "@opentui/core";
import { bold, fg, StyledText, t } from "@opentui/core";
import { useTerminalDimensions, type BoxProps } from "@opentui/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nextScrollTop } from "./scroll.js";
import {
  patternPanelRows,
  setPatternDraft,
  setPatternFilter,
  setPatternIndex,
  setPatternInput,
  togglePattern,
  type PatternPanelRow,
  type SweepUiState,
} from "./state.js";
import type { ThemeTokens } from "./theme.js";

export interface PatternPanelProps {
  state: SweepUiState;
  tokens: ThemeTokens;
  /** Inner pane width for right-edge note truncation. */
  paneWidth: number;
  onMutate: (fn: (s: SweepUiState) => SweepUiState) => void;
  /** Enter on an "add" draft - the app validates and either adds or notifies. */
  onSubmitDraft: () => void;
}

/**
 * Row content for one pattern: `✓ name` on, `· name` off, a source tag for
 * opt-in and custom rows (defaults are the norm and get no badge), then the
 * catalog note dimmed against the pane edge. Pattern text is sanitized -
 * custom entries are user input.
 */
function patternRowContent(row: PatternPanelRow, tokens: ThemeTokens, width: number): StyledText {
  const enabled = row.enabled === true;
  const mark = enabled ? fg(tokens.positive)("✓") : fg(tokens.textDim)("·");
  const name = fg(enabled ? tokens.text : tokens.textSecondary)(
    sanitizeTerminalText(row.pattern ?? ""),
  );
  const tagText = row.source === "custom" ? " custom" : row.source === "opt-in" ? " opt-in" : "";
  const tag = tagText ? fg(row.source === "custom" ? tokens.info : tokens.textDim)(tagText) : "";

  // Cells: "✓ " + name + tag + "  " before the note, 2 spare against the edge.
  const fixedCells = 2 + (row.pattern ?? "").length + tagText.length + 2;
  const noteWidth = width - fixedCells - 2;
  const raw = row.note ?? "";
  const note =
    noteWidth > 4 && raw.length > 0
      ? fg(tokens.textMuted)(
          `  ${sanitizeTerminalText(raw.length > noteWidth ? `${raw.slice(0, noteWidth - 1)}…` : raw)}`,
        )
      : "";
  return t`${mark} ${name}${tag}${note}`;
}

const PatternRow = memo(function PatternRow({
  row,
  selectableIndex,
  isCursor,
  focused,
  isHovered,
  tokens,
  width,
  onCursor,
  onToggle,
  onHover,
}: {
  row: PatternPanelRow;
  selectableIndex: number;
  isCursor: boolean;
  focused: boolean;
  isHovered: boolean;
  tokens: ThemeTokens;
  width: number;
  onCursor: (selectableIndex: number) => void;
  onToggle: (pattern: string) => void;
  onHover: (index: number, hovered: boolean) => void;
}) {
  const rowBg = isCursor
    ? focused
      ? tokens.selectionBg
      : tokens.selectionSoftBg
    : isHovered
      ? tokens.hoverBg
      : undefined;

  // BoxProps lags the runtime's mouse surface - same cast the artifact rows use.
  const mouseProps = {
    selectable: true,
    onMouseMove: () => onHover(selectableIndex, true),
    // `out` clears hover - `onMouseLeave` is not a real OpenTUI event name, so
    // the stale hover tint never cleared when the pointer left the row.
    onMouseOut: () => onHover(selectableIndex, false),
    // First click moves the cursor; clicking the cursor row toggles. Same
    // idiom as the artifact list, so the two panes feel identical.
    onMouseDown: () => {
      if (isCursor && row.pattern) onToggle(row.pattern);
      else onCursor(selectableIndex);
    },
  } as BoxProps;

  return (
    <box
      width="100%"
      height={1}
      flexGrow={0}
      flexShrink={0}
      overflow="hidden"
      paddingLeft={1}
      {...(rowBg ? { backgroundColor: rowBg } : {})}
      {...mouseProps}
    >
      <text content={patternRowContent(row, tokens, width)} wrapMode="none" />
    </box>
  );
});

/**
 * The pattern editor pane: a grouped catalog list (ecosystem headers are not
 * selectable), a `/` filter, and an `a` add line. The pane owns no destructive
 * or persistent action - `w` writes a .sweeprc via an app-level handler, `r`
 * rescans; toggles only edit scan state until one of those runs.
 */
export function PatternPanel({
  state,
  tokens,
  paneWidth,
  onMutate,
  onSubmitDraft,
}: PatternPanelProps) {
  const dimensions = useTerminalDimensions();
  const rows = useMemo(() => patternPanelRows(state), [state]);

  // patternIndex counts selectable rows only; the display array interleaves
  // group headers, so translate once per render.
  const { selectableIndexByRow, rowIndexBySelectable, selectableCount } = useMemo(() => {
    const selByRow = new Map<number, number>();
    const rowBySel = new Map<number, number>();
    let sel = 0;
    rows.forEach((row, rowIndex) => {
      if (row.kind === "pattern") {
        selByRow.set(rowIndex, sel);
        rowBySel.set(sel, rowIndex);
        sel += 1;
      }
    });
    return {
      selectableIndexByRow: selByRow,
      rowIndexBySelectable: rowBySel,
      selectableCount: sel,
    };
  }, [rows]);

  const cursorRow = rowIndexBySelectable.get(
    Math.min(state.patternIndex, Math.max(0, selectableCount - 1)),
  );

  const listRef = useRef<BoxRenderable | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  // Seeded from the terminal for the first frame, then exact via onSizeChange.
  const [viewportHeight, setViewportHeight] = useState(() => Math.max(1, dimensions.height - 8));

  const scrollTopRef = useRef(0);
  const maxScrollTop = Math.max(0, rows.length - viewportHeight);
  const appliedTop = Math.min(
    maxScrollTop,
    Math.max(0, nextScrollTop(scrollTopRef.current, viewportHeight, cursorRow ?? 0)),
  );
  useEffect(() => {
    scrollTopRef.current = appliedTop;
  });
  const visibleRows = useMemo(
    () => rows.slice(appliedTop, appliedTop + viewportHeight),
    [rows, appliedTop, viewportHeight],
  );

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
      // The wheel moves the cursor, not a detached viewport - same rule as
      // the artifact list, so space always acts on a row that is on screen.
      const delta = Math.max(1, Math.abs(event.scroll?.delta ?? 1)) * 3;
      onMutate((s) => setPatternIndex(s, s.patternIndex + (direction === "up" ? -delta : delta)));
    },
    [onMutate],
  );

  const inputFocused = state.focus === "patternInput";
  const filterActive = state.patternFilter.length > 0;
  const showInput = inputFocused || filterActive;

  return (
    <box width="100%" flexGrow={1} minHeight={0} flexDirection="column">
      {showInput ? (
        <box width="100%" height={1} flexShrink={0} paddingLeft={1}>
          <input
            focused={inputFocused}
            value={state.patternInputMode === "add" ? state.patternDraft : state.patternFilter}
            placeholder={
              state.patternInputMode === "add"
                ? "new pattern, e.g. .cache - enter adds"
                : "filter patterns…"
            }
            backgroundColor={tokens.surfaceInset}
            focusedBackgroundColor={tokens.surfaceInset}
            textColor={tokens.text}
            cursorColor={tokens.accent}
            onInput={(value: string) =>
              onMutate((s) =>
                s.patternInputMode === "add"
                  ? setPatternDraft(s, value)
                  : setPatternFilter(s, value),
              )
            }
            onSubmit={() => {
              if (state.patternInputMode === "add") onSubmitDraft();
              else onMutate((s) => setPatternInput(s, null));
            }}
          />
        </box>
      ) : (
        <box width="100%" height={1} flexShrink={0} paddingLeft={1}>
          <text
            content={t`${fg(tokens.textDim)("space toggles · / finds · a adds · w saves .sweeprc · r rescans")}`}
            wrapMode="none"
          />
        </box>
      )}
      <box width="100%" flexGrow={1} minHeight={0} flexDirection="row">
        <box
          ref={listRef}
          width="100%"
          flexGrow={1}
          minHeight={0}
          flexDirection="column"
          overflow="hidden"
          onSizeChange={handleSizeChange}
          onMouseScroll={handleWheel}
        >
          {visibleRows.length === 0 ? (
            <box flexGrow={1} justifyContent="center" alignItems="center">
              <text
                content={
                  filterActive
                    ? `No patterns match "${sanitizeTerminalText(state.patternFilter)}".`
                    : "No patterns."
                }
                fg={tokens.textMuted}
                wrapMode="none"
              />
            </box>
          ) : (
            visibleRows.map((row, offset) => {
              const rowIndex = appliedTop + offset;
              if (row.kind === "group") {
                return (
                  <box
                    key={`g-${row.label ?? rowIndex}`}
                    width="100%"
                    height={1}
                    flexShrink={0}
                    overflow="hidden"
                    paddingLeft={1}
                  >
                    <text
                      content={t`${bold(fg(tokens.textDim)(sanitizeTerminalText(row.label ?? "")))}`}
                      wrapMode="none"
                    />
                  </box>
                );
              }
              const selectableIndex = selectableIndexByRow.get(rowIndex) ?? 0;
              return (
                <PatternRow
                  key={`p-${row.pattern ?? rowIndex}`}
                  row={row}
                  selectableIndex={selectableIndex}
                  isCursor={rowIndex === cursorRow}
                  focused={state.focus === "patterns" || inputFocused}
                  isHovered={hovered === selectableIndex}
                  tokens={tokens}
                  width={paneWidth}
                  onCursor={(sel) => onMutate((s) => setPatternIndex(s, sel))}
                  onToggle={(pattern) => onMutate((s) => togglePattern(s, pattern))}
                  onHover={(i, h) => setHovered(h ? i : null)}
                />
              );
            })
          )}
        </box>
      </box>
    </box>
  );
}
