import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { useMemo } from "react";
import { ArtifactList } from "./ArtifactList.js";
import { ScopeSidebar } from "./ScopeSidebar.js";
import { buildContextCaption, formatPatternRow } from "./presentation.js";
import type { UiDisplayRow } from "./rows.js";
import {
  setFilter,
  setRowIndex,
  setScopeFilter,
  toggleGroup,
  togglePattern,
  type SweepUiState,
  type UiFocus,
} from "./state.js";
import type { ThemeTokens } from "./theme.js";

export interface ReviewPaneProps {
  state: SweepUiState;
  plan: ScanPlan;
  tokens: ThemeTokens;
  showSidebar: boolean;
  sidebarWidth: number;
  filterDraft: string;
  displayRows: UiDisplayRow[];
  visibleItems: ScanCandidate[];
  candidatesById: Map<string, ScanCandidate>;
  listSelectIndex: number;
  onFilterDraftChange: (value: string) => void;
  onMutate: (fn: (s: SweepUiState) => SweepUiState) => void;
  onFocusPanel: (focus: UiFocus) => void;
  onToggleSelection: (candidateId: string) => void;
}

export function ReviewPane({
  state,
  tokens,
  showSidebar,
  sidebarWidth,
  filterDraft,
  displayRows,
  visibleItems,
  candidatesById,
  listSelectIndex,
  onFilterDraftChange,
  onMutate,
  onFocusPanel,
  onToggleSelection,
}: ReviewPaneProps) {
  const patternOptions = useMemo(
    () =>
      state.catalogPatterns.map((pattern) => ({
        name: formatPatternRow(pattern, !state.disabledPatterns.has(pattern)),
        value: pattern,
        description: "",
      })),
    [state.catalogPatterns, state.disabledPatterns],
  );

  const scopeEmpty = state.scopeFilter !== null && visibleItems.length === 0;
  const filterEmpty = visibleItems.length === 0 && !scopeEmpty;
  const searchFocused = state.focus === "search";
  const listFocused = state.focus === "list" || state.focus === "patterns";

  const contextCaption = useMemo(
    () => (listFocused ? buildContextCaption(state) : undefined),
    [state, listFocused],
  );

  return (
    <box width="100%" flexGrow={1} flexDirection="row" gap={1}>
      {showSidebar ? (
        <box
          width={sidebarWidth}
          height="100%"
          flexDirection="column"
          borderStyle="rounded"
          border
          borderColor={state.focus === "sidebar" ? tokens.borderFocus : tokens.borderSoft}
          title=" scopes "
          backgroundColor={tokens.bg}
          overflow="hidden"
          paddingX={1}
          paddingTop={1}
          paddingBottom={0}
        >
          <ScopeSidebar
            state={state}
            tokens={tokens}
            focused={state.focus === "sidebar"}
            paneWidth={sidebarWidth - 4}
            onApplyScope={(scopeFilter) => {
              onMutate((s) => setScopeFilter(s, scopeFilter));
              onFocusPanel("list");
            }}
          />
        </box>
      ) : null}
      <box
        flexGrow={1}
        height="100%"
        flexDirection="column"
        gap={1}
        borderStyle="rounded"
        border
        borderColor={listFocused || searchFocused ? tokens.borderFocus : tokens.borderSoft}
        title=" artifacts "
        {...(contextCaption ? { bottomTitle: contextCaption } : {})}
        backgroundColor={tokens.surface}
        overflow="hidden"
        paddingX={1}
        paddingTop={1}
        paddingBottom={0}
      >
        <input
          focused={searchFocused}
          value={filterDraft}
          placeholder="filter artifacts…  (/ to focus)"
          backgroundColor={tokens.surfaceInset}
          focusedBackgroundColor={tokens.surfaceInset}
          textColor={tokens.text}
          cursorColor={tokens.accent}
          onInput={(value: string) => {
            onFilterDraftChange(value);
            onMutate((s) => setFilter(s, value));
          }}
          onSubmit={() => onFocusPanel("list")}
        />
        {state.focus === "patterns" ? (
          <select
            focused
            showDescription={false}
            showScrollIndicator
            wrapSelection={false}
            backgroundColor={tokens.surface}
            textColor={tokens.textSecondary}
            selectedBackgroundColor={tokens.selectionBg}
            selectedTextColor={tokens.accent}
            selectedIndex={listSelectIndex}
            options={patternOptions}
            onChange={(index: number) => onMutate((s) => setRowIndex(s, index))}
            onSelect={(_: number, option: { value?: string } | null) => {
              const value = option?.value;
              if (value) onMutate((s) => togglePattern(s, value));
            }}
          />
        ) : scopeEmpty ? (
          <box flexGrow={1} justifyContent="center" alignItems="center" padding={2}>
            <text content="No artifacts in this scope." fg={tokens.textMuted} />
          </box>
        ) : filterEmpty ? (
          <box flexGrow={1} justifyContent="center" alignItems="center" padding={2}>
            <text
              content={
                filterDraft.length > 0
                  ? `No artifacts match “${filterDraft}”.`
                  : "No artifacts match the current filter."
              }
              fg={tokens.textMuted}
            />
          </box>
        ) : (
          <ArtifactList
            rows={displayRows}
            candidatesById={candidatesById}
            selectedIds={state.selectedIds}
            currentRowIndex={state.rowIndex}
            focused={state.focus === "list"}
            tokens={tokens}
            onToggleSelection={onToggleSelection}
            onToggleGroup={(groupKey) => onMutate((s) => toggleGroup(s, groupKey))}
            onSetCursor={(rowIndex) => onMutate((s) => setRowIndex(s, rowIndex))}
          />
        )}
      </box>
    </box>
  );
}
