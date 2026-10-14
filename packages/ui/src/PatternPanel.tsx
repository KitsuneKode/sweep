import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import type { BoxRenderable, MouseEvent } from "@opentui/core";
import { bold, fg, StyledText, t } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionButton } from "./ActionButton.js";
import { SelectableRow } from "./SelectableRow.js";
import { ScrollbarColumn, scrollbarModel } from "./ScrollbarColumn.js";
import { cellWidth, clipCells } from "./text-cells.js";
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
  onSave?: () => void;
  onInspect?: (pattern: string) => void;
}

/**
 * Text beside a pattern checkbox: its name, a source tag for
 * opt-in and custom rows (defaults are the norm and get no badge), then the
 * catalog note dimmed against the pane edge. Pattern text is sanitized -
 * custom entries are user input.
 */
function patternRowContent(row: PatternPanelRow, tokens: ThemeTokens, width: number): StyledText {
  const enabled = row.enabled === true;
  const safePattern = sanitizeTerminalText(row.pattern ?? "");
  const tagText =
    width >= 16
      ? row.source === "custom"
        ? " custom"
        : row.source === "opt-in"
          ? " opt-in"
          : ""
      : "";
  const shown = clipCells(safePattern, Math.max(1, width - cellWidth(tagText)));
  const name = fg(enabled ? tokens.text : tokens.textSecondary)(shown);
  const tag = tagText ? fg(row.source === "custom" ? tokens.info : tokens.textDim)(tagText) : "";
  const noteWidth = width - cellWidth(shown) - cellWidth(tagText) - 2;
  const safeNote = sanitizeTerminalText(row.note ?? "");
  const note =
    noteWidth > 4 && safeNote.length > 0
      ? fg(tokens.textMuted)(`  ${clipCells(safeNote, noteWidth)}`)
      : "";
  return t`${name}${tag}${note}`;
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
  return (
    <SelectableRow
      selected={isCursor && focused}
      emphasized={isCursor && !focused}
      hovered={isHovered}
      tokens={tokens}
      onSelect={() => onCursor(selectableIndex)}
      onHoverChange={(hovered) => onHover(selectableIndex, hovered)}
    >
      <box width="100%" height={1} flexDirection="row" paddingLeft={1} overflow="hidden">
        <ActionButton
          tokens={tokens}
          label={row.enabled ? "[x]" : "[ ]"}
          framed={false}
          onPress={() => {
            if (row.pattern) onToggle(row.pattern);
          }}
        />
        <text content=" " />
        <text content={patternRowContent(row, tokens, Math.max(1, width - 5))} wrapMode="none" />
      </box>
    </SelectableRow>
  );
});

/** Pattern input and explicit mouse actions, separate from list windowing. */
function PatternControls({
  state,
  tokens,
  onMutate,
  onSubmitDraft,
  onSave,
  onInspect,
  selectedPattern,
}: Omit<PatternPanelProps, "paneWidth"> & { selectedPattern: string | undefined }) {
  const inputFocused = state.focus === "patternInput";
  const showInput = inputFocused || state.patternFilter.length > 0;
  return (
    <>
      <box flexDirection="row" flexWrap="wrap" gap={1} flexShrink={0}>
        <ActionButton
          tokens={tokens}
          label="Find"
          onPress={() => onMutate((s) => setPatternInput(s, "filter"))}
        />
        <ActionButton
          tokens={tokens}
          label="Add"
          disabled={inputFocused && state.patternInputMode === "add"}
          onPress={() => onMutate((s) => setPatternInput(s, "add"))}
        />
        {onInspect ? (
          <ActionButton
            tokens={tokens}
            label="Details"
            disabled={!selectedPattern}
            onPress={() => {
              if (selectedPattern) onInspect(selectedPattern);
            }}
          />
        ) : null}
        <ActionButton
          tokens={tokens}
          label="Save"
          disabled={!onSave || (inputFocused && state.patternInputMode === "add")}
          onPress={() => onSave?.()}
        />
      </box>
      {showInput ? (
        <box width="100%" height={1} flexShrink={0} flexDirection="row" gap={1}>
          <input
            flexGrow={1}
            minWidth={1}
            maxLength={512}
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
          <ActionButton
            tokens={tokens}
            label={state.patternInputMode === "add" ? "Add pattern" : "Done"}
            onPress={() => {
              if (state.patternInputMode === "add") onSubmitDraft();
              else onMutate((s) => setPatternInput(s, null));
            }}
          />
        </box>
      ) : (
        <box width="100%" height={1} flexShrink={0} paddingLeft={1}>
          <text
            content={t`${fg(tokens.textDim)("Checkboxes edit patterns; saving updates .sweeprc.")}`}
            wrapMode="none"
          />
        </box>
      )}
    </>
  );
}

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
  onSave,
  onInspect,
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

  const selectedPattern = rows[cursorRow ?? -1]?.pattern;
  const scrollbar = scrollbarModel(rows.length, viewportHeight, appliedTop);
  const filterActive = state.patternFilter.length > 0;

  return (
    <box width="100%" flexGrow={1} minHeight={0} flexDirection="column" onMouseScroll={handleWheel}>
      <PatternControls
        state={state}
        tokens={tokens}
        selectedPattern={selectedPattern}
        onMutate={onMutate}
        onSubmitDraft={onSubmitDraft}
        {...(onSave ? { onSave } : {})}
        {...(onInspect ? { onInspect } : {})}
      />
      <box width="100%" flexGrow={1} minHeight={0} flexDirection="row">
        <box
          ref={listRef}
          flexGrow={1}
          minWidth={0}
          minHeight={0}
          flexDirection="column"
          overflow="hidden"
          onSizeChange={handleSizeChange}
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
                  focused={state.focus === "patterns" || state.focus === "patternInput"}
                  isHovered={hovered === selectableIndex}
                  tokens={tokens}
                  width={paneWidth - (scrollbar ? 1 : 0)}
                  onCursor={(sel) => onMutate((s) => setPatternIndex(s, sel))}
                  onToggle={(pattern) => onMutate((s) => togglePattern(s, pattern))}
                  onHover={(i, h) => setHovered(h ? i : null)}
                />
              );
            })
          )}
        </box>
        {scrollbar ? (
          <ScrollbarColumn
            tokens={tokens}
            model={scrollbar}
            height={viewportHeight}
            rowCount={rows.length}
            onSeek={(row) => {
              let index = selectableCount - 1;
              for (const [selectable, display] of rowIndexBySelectable) {
                if (display >= row) {
                  index = selectable;
                  break;
                }
              }
              onMutate((s) => setPatternIndex(s, Math.max(0, index)));
            }}
          />
        ) : null}
      </box>
    </box>
  );
}
