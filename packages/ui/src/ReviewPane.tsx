import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { useMemo } from "react";
import { ArtifactList } from "./ArtifactList.js";
import { ScopeSidebar } from "./ScopeSidebar.js";
import { formatPatternRow } from "./presentation.js";
import type { UiDisplayRow } from "./rows.js";
import {
  setFilter,
  setRowIndex,
  setScopeFilter,
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

  const riskLabel = state.riskFilter === "all" ? "all risks" : `${state.riskFilter} only`;
  const scopeEmpty = state.scopeFilter !== null && visibleItems.length === 0;
  const filterEmpty = visibleItems.length === 0 && !scopeEmpty;

  return (
    <box width="100%" flexGrow={1} flexDirection="row" gap={1}>
      {showSidebar ? (
        <box
          width={sidebarWidth}
          height="100%"
          border
          borderColor={state.focus === "sidebar" ? tokens.borderFocus : tokens.borderSoft}
          backgroundColor={tokens.bg}
          paddingX={1}
          paddingY={1}
        >
          <ScopeSidebar
            state={state}
            tokens={tokens}
            focused={state.focus === "sidebar"}
            onApplyScope={(scopeFilter) => {
              onMutate((s) => setScopeFilter(s, scopeFilter));
              onFocusPanel("list");
            }}
          />
        </box>
      ) : null}
      <box flexGrow={1} height="100%" flexDirection="column" gap={1}>
        <input
          focused={state.focus === "search"}
          value={filterDraft}
          placeholder="filter artifacts… (/ to focus)"
          onInput={(value) => {
            onFilterDraftChange(value);
            onMutate((s) => setFilter(s, value));
          }}
        />
        <box
          flexGrow={1}
          border
          borderColor={
            state.focus === "list" || state.focus === "patterns"
              ? tokens.borderFocus
              : tokens.borderSoft
          }
          backgroundColor={tokens.surface}
          paddingX={1}
          flexDirection="column"
        >
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
              onChange={(index) => onMutate((s) => setRowIndex(s, index))}
              onSelect={(_, option) => {
                if (option?.value) onMutate((s) => togglePattern(s, option.value));
              }}
            />
          ) : scopeEmpty ? (
            <box flexGrow={1} justifyContent="center" alignItems="center" padding={2}>
              <text content="No artifacts in this scope." fg={tokens.textMuted} />
            </box>
          ) : filterEmpty ? (
            <box flexGrow={1} justifyContent="center" alignItems="center" padding={2}>
              <text content="No artifacts match the current filter." fg={tokens.textMuted} />
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
            />
          )}
        </box>
        <text content={`risk filter: ${riskLabel} (1-4)`} fg={tokens.textMuted} />
      </box>
    </box>
  );
}
