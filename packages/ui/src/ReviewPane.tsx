import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { ArtifactList } from "./ArtifactList.js";
import { ScopeSidebar } from "./ScopeSidebar.js";
import { buildContextCaption, formatPatternRow } from "./presentation.js";
import type { UiDisplayRow } from "./rows.js";
import {
  setFilter,
  setPatternIndex,
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

  const dimensions = useTerminalDimensions();
  // Artifact pane inner width: total terminal width minus sidebar (if shown),
  // gap between panes (1), outer padding (2), pane border+padding (4).
  const artifactPaneInnerWidth = Math.max(
    36,
    dimensions.width - (showSidebar ? sidebarWidth + 1 : 0) - 2 - 4,
  );

  const hasFilter = filterDraft.length > 0 || state.riskFilter !== "all";
  const scopeEmpty = state.scopeFilter !== null && visibleItems.length === 0;
  const nothingFound = visibleItems.length === 0 && !scopeEmpty && !state.scanning;
  const searchFocused = state.focus === "search";
  const listFocused = state.focus === "list" || state.focus === "patterns";
  const emptyScan = state.scanning && state.candidates.length === 0;

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
          title={state.focus === "sidebar" ? " › scopes " : " scopes "}
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
        gap={0}
        borderStyle="rounded"
        border
        borderColor={listFocused || searchFocused ? tokens.borderFocus : tokens.borderSoft}
        title={searchFocused ? " › filter " : " artifacts "}
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
        {state.scanning && state.candidates.length > 0 ? (
          <box width="100%" paddingTop={0} paddingBottom={0} flexShrink={0}>
            <text
              content={`scanning… ${state.candidates.length} found  ·  r cancel / rescan`}
              fg={tokens.accent}
            />
          </box>
        ) : null}
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
            onChange={(index: number) => onMutate((s) => setPatternIndex(s, index))}
            onSelect={(_: number, option: { value?: string } | null) => {
              const value = option?.value;
              if (value) onMutate((s) => togglePattern(s, value));
            }}
          />
        ) : emptyScan ? (
          <ScanningPlaceholder tokens={tokens} />
        ) : scopeEmpty ? (
          <box flexGrow={1} justifyContent="center" alignItems="center" padding={2}>
            <text content="No artifacts in this scope." fg={tokens.textMuted} />
            <text content="h or esc returns to all scopes." fg={tokens.textDim} />
          </box>
        ) : nothingFound ? (
          <box flexGrow={1} justifyContent="center" alignItems="center" padding={2}>
            <text
              content={
                hasFilter
                  ? filterDraft.length > 0
                    ? `No artifacts match "${filterDraft}".`
                    : "No artifacts match the current filter."
                  : "No artifacts found."
              }
              fg={tokens.textMuted}
            />
            <text
              content={hasFilter ? "esc clears the filter. / to search." : "r rescans from disk."}
              fg={tokens.textDim}
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
            paneWidth={artifactPaneInnerWidth}
            scanning={state.scanning}
            onToggleSelection={onToggleSelection}
            onToggleGroup={(groupKey) => onMutate((s) => toggleGroup(s, groupKey))}
            onSetCursor={(rowIndex) => onMutate((s) => setRowIndex(s, rowIndex))}
          />
        )}
      </box>
    </box>
  );
}

function ScanningPlaceholder({ tokens }: { tokens: ThemeTokens }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => value + 1), 400);
    return () => clearInterval(timer);
  }, []);

  const dots = ".".repeat((frame % 3) + 1).padEnd(3, " ");

  return (
    <box flexGrow={1} justifyContent="center" alignItems="center" padding={2} gap={1}>
      <text content={`◆ Scanning${dots}`} fg={tokens.accent} />
      <text content="Artifacts appear here as they are discovered." fg={tokens.textMuted} />
      <text content="space queues · a selects safe+caution · enter applies" fg={tokens.textDim} />
    </box>
  );
}
