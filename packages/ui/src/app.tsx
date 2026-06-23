import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { StyledText } from "@opentui/core";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { Component, type ReactNode, useCallback, useMemo, useReducer, useState } from "react";
import { groupCandidatesByScope } from "./grouping.js";
import {
  buildContextLine,
  buildFooterLine,
  buildHeaderLine,
  buildSidebarLine,
  formatArtifactRow,
  formatGroupHeaderRow,
  formatPatternRow,
} from "./presentation.js";
import { buildDisplayRows } from "./rows.js";
import {
  applyUiSelection,
  clearSelection,
  countSelectedDangerous,
  createUiState,
  getUiSummary,
  rescanConfigFromState,
  selectVisible,
  setFilter,
  setFocus,
  setRiskFilter,
  setRowIndex,
  setScopeFilter,
  setThemeMode,
  toggleCurrentSelection,
  togglePattern,
  type SweepUiInitOptions,
  type SweepUiState,
} from "./state.js";
import { getVisibleCandidates } from "./state/selectors.js";
import { cycleThemeMode, resolveTheme, type ThemeTokens } from "./theme.js";

export interface SweepUiOptions {
  yes?: boolean;
  dryRun?: boolean;
  init?: SweepUiInitOptions;
}

export type SweepUiOutcome =
  | { type: "apply"; plan: ScanPlan }
  | { type: "rescan"; disabledPatterns: string[]; extraPatterns: string[] }
  | { type: "abort" };

const ALL_SCOPES_KEY = "__all__";

type UiAction =
  | { type: "replace"; state: SweepUiState }
  | { type: "mutate"; fn: (state: SweepUiState) => SweepUiState };

function uiReducer(state: SweepUiState, action: UiAction): SweepUiState {
  if (action.type === "replace") return action.state;
  return action.fn(state);
}

export interface SweepAppProps {
  plan: ScanPlan;
  dryRun?: boolean;
  onDone: (outcome: SweepUiOutcome) => void;
  init?: SweepUiInitOptions;
}

function styledContentFallback(message: string): ReactNode {
  return (
    <box width="100%" height="100%" flexDirection="column" padding={1} backgroundColor="#090b10">
      <text content="sweep — the interactive view hit an error" fg="#f87171" />
      <text content="" />
      <text content={message} fg="#e2e8f0" />
      <text content="" />
      <text content="Press q or Ctrl+C to exit, then re-run with --no-ui." fg="#64748b" />
    </box>
  );
}

class UiErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override render(): ReactNode {
    if (this.state.error) {
      return styledContentFallback(this.state.error.message);
    }
    return this.props.children;
  }
}

function HelpOverlay({ tokens }: { tokens: ThemeTokens }) {
  return (
    <box
      position="absolute"
      top={2}
      left={4}
      right={4}
      border
      borderColor={tokens.borderFocus}
      padding={1}
      backgroundColor={tokens.surface}
      flexDirection="column"
      gap={0}
    >
      <text content={`sweep — keyboard help`} fg={tokens.accent} />
      <text content="" />
      <text content="↑/↓ j/k  move   space  toggle selection" fg={tokens.text} />
      <text content="a  select all visible   u  clear selection" fg={tokens.text} />
      <text content="s  deselect visible     /  focus filter" fg={tokens.text} />
      <text content="tab  cycle panels       p  pattern editor" fg={tokens.text} />
      <text content="r  rescan patterns      t  cycle theme" fg={tokens.text} />
      <text content="1-4  risk filter        enter  apply" fg={tokens.text} />
      <text content="?  close help           q / esc  quit" fg={tokens.textMuted} />
    </box>
  );
}

function ConfirmOverlay({
  tokens,
  selectedCount,
  dangerousCount,
  dryRun,
}: {
  tokens: ThemeTokens;
  selectedCount: number;
  dangerousCount: number;
  dryRun?: boolean;
}) {
  const action = dryRun ? "preview delete for" : "delete";
  const dangerNote =
    dangerousCount > 0
      ? ` Includes ${dangerousCount} dangerous item${dangerousCount === 1 ? "" : "s"}.`
      : "";
  return (
    <box
      position="absolute"
      top={4}
      left={6}
      right={6}
      border
      borderColor={dangerousCount > 0 ? tokens.danger : tokens.borderFocus}
      padding={1}
      backgroundColor={tokens.surface}
      flexDirection="column"
      gap={0}
    >
      <text
        content={`Apply ${action} ${selectedCount} selected item${selectedCount === 1 ? "" : "s"}?${dangerNote}`}
        fg={tokens.text}
      />
      <text content="" />
      <text content="y  confirm   n / esc  cancel" fg={tokens.textMuted} />
    </box>
  );
}

export function SweepApp({ plan, dryRun, onDone, init }: SweepAppProps) {
  const [state, dispatch] = useReducer(uiReducer, plan, (p: ScanPlan) => createUiState(p, init));
  const [showHelp, setShowHelp] = useState(false);
  const [pendingApply, setPendingApply] = useState(false);
  const [filterDraft, setFilterDraft] = useState("");

  const tokens = useMemo(() => resolveTheme(state.themeMode), [state.themeMode]);
  const summary = useMemo(() => getUiSummary(state), [state]);
  const dimensions = useTerminalDimensions();
  const sidebarWidth = dimensions.width >= 100 ? 28 : 22;
  const showSidebar = dimensions.width >= 72;

  const mutate = useCallback((fn: (s: SweepUiState) => SweepUiState) => {
    dispatch({ type: "mutate", fn });
  }, []);

  const visibleItems = useMemo(() => getVisibleCandidates(state), [state]);
  const displayRows = useMemo(() => buildDisplayRows(state), [state]);
  const dangerousSelected = useMemo(() => countSelectedDangerous(state), [state]);

  const listSelectIndex = useMemo(() => {
    if (state.focus === "patterns") return state.rowIndex;
    const currentId = displayRows[state.rowIndex];
    if (!currentId || currentId.kind !== "item") return 0;
    const idx = visibleItems.findIndex((c: ScanCandidate) => c.id === currentId.candidateId);
    return idx >= 0 ? idx : 0;
  }, [state, displayRows, visibleItems]);

  const finalize = useCallback(
    (outcome: SweepUiOutcome) => {
      onDone(outcome);
    },
    [onDone],
  );

  const requestApply = useCallback(() => {
    if (summary.selectedCount === 0) return;
    if (dangerousSelected > 0 || summary.dangerousVisibleCount > 0) {
      setPendingApply(true);
      return;
    }
    finalize({ type: "apply", plan: applyUiSelection(plan, state) });
  }, [summary, dangerousSelected, finalize, plan, state]);

  const focusPanel = useCallback(
    (focus: SweepUiState["focus"]) => {
      mutate((s) => setFocus(s, focus));
    },
    [mutate],
  );

  useKeyboard((key) => {
    if (pendingApply) {
      if (key.name === "y") {
        setPendingApply(false);
        finalize({ type: "apply", plan: applyUiSelection(plan, state) });
      } else if (key.name === "n" || key.name === "escape") {
        setPendingApply(false);
      }
      return;
    }

    if (showHelp) {
      if (key.name === "?" || key.name === "escape") {
        setShowHelp(false);
      }
      return;
    }

    // While typing in the filter, only structural keys are intercepted; every
    // other key must reach the focused <input> so it can be typed literally.
    if (state.focus === "search") {
      if (key.name === "escape" || key.name === "return") {
        focusPanel("list");
      } else if (key.name === "tab") {
        focusPanel(showSidebar ? "sidebar" : "list");
      }
      return;
    }

    if (key.name === "escape" || key.name === "q") {
      finalize({ type: "abort" });
      return;
    }

    if (key.name === "?") {
      setShowHelp(true);
      return;
    }

    if (key.name === "tab") {
      const order: SweepUiState["focus"][] = showSidebar
        ? ["search", "sidebar", "list"]
        : ["search", "list"];
      const current = state.focus === "patterns" ? "list" : state.focus;
      const idx = order.indexOf(current);
      const next = order[(idx + 1) % order.length] ?? "list";
      focusPanel(next);
      return;
    }

    if (key.name === "t") {
      mutate((s) => setThemeMode(s, cycleThemeMode(s.themeMode)));
      return;
    }

    if (key.name === "p") {
      focusPanel(state.focus === "patterns" ? "list" : "patterns");
      return;
    }

    if (key.name === "r") {
      const { disabledPatterns, extraPatterns } = rescanConfigFromState(state);
      finalize({ type: "rescan", disabledPatterns, extraPatterns });
      return;
    }

    if (key.name === "/") {
      focusPanel("search");
      return;
    }

    // Sidebar and the list/pattern <select> own their own navigation
    // (↑/↓/j/k and Enter are native SelectRenderable bindings), so the global
    // handler must not also move the cursor or it double-steps.
    if (state.focus === "sidebar") {
      return;
    }

    if (state.focus === "patterns") {
      if (key.name === "space") {
        const pattern = state.catalogPatterns[listSelectIndex];
        if (pattern) mutate((s) => togglePattern(s, pattern));
      }
      return;
    }

    if (key.name === "space") {
      mutate((s) => toggleCurrentSelection(s));
      return;
    }

    if (key.name === "s") {
      mutate((s) => selectVisible(s, false));
      return;
    }

    if (key.name === "a") {
      mutate((s) => selectVisible(s, true));
      return;
    }

    if (key.name === "u") {
      mutate((s) => clearSelection(s));
      return;
    }

    if (key.name === "1") {
      mutate((s) => setRiskFilter(s, "all"));
      return;
    }
    if (key.name === "2") {
      mutate((s) => setRiskFilter(s, "safe"));
      return;
    }
    if (key.name === "3") {
      mutate((s) => setRiskFilter(s, "caution"));
      return;
    }
    if (key.name === "4") {
      mutate((s) => setRiskFilter(s, "dangerous"));
    }
  });

  const scopeGroups = useMemo(
    () => groupCandidatesByScope(state.targetDir, state.candidates),
    [state.targetDir, state.candidates],
  );

  const sidebarOptions = useMemo(
    () => [
      {
        name: buildSidebarLine(
          "all scopes",
          state.candidates.length,
          state.scopeFilter === null,
          tokens,
        ),
        value: ALL_SCOPES_KEY,
        description: "",
      },
      ...scopeGroups.map((group: { key: string; label: string; candidateIds: string[] }) => ({
        name: buildSidebarLine(
          group.label,
          group.candidateIds.length,
          state.scopeFilter === group.key,
          tokens,
        ),
        value: group.key,
        description: "",
      })),
    ],
    [state.candidates.length, state.scopeFilter, scopeGroups, tokens],
  );

  const patternOptions = useMemo(
    () =>
      state.catalogPatterns.map((pattern: string) => ({
        name: formatPatternRow(pattern, !state.disabledPatterns.has(pattern)),
        value: pattern,
        description: "",
      })),
    [state.catalogPatterns, state.disabledPatterns],
  );

  const itemOptions = useMemo(
    () =>
      visibleItems.map((candidate: ScanCandidate) => ({
        name: formatArtifactRow(candidate, state.selectedIds.has(candidate.id), tokens),
        value: candidate.id,
        description: "",
      })),
    [visibleItems, state.selectedIds, tokens],
  );

  const groupHeaders = useMemo(() => {
    if (state.focus === "patterns") return [];
    const headers: { key: string; label: string }[] = [];
    let lastKey = "";
    for (const row of displayRows) {
      if (row.kind === "header" && row.groupKey !== lastKey) {
        headers.push({ key: row.groupKey, label: formatGroupHeaderRow(row) });
        lastKey = row.groupKey;
      }
    }
    return headers;
  }, [displayRows, state.focus]);

  const headerContent: StyledText = buildHeaderLine(plan, summary, tokens, dryRun);
  const contextContent: StyledText = buildContextLine(state, tokens);
  const footerContent: StyledText = buildFooterLine(
    state.focus,
    tokens,
    dryRun,
    state.patternsDirty,
  );
  const riskLabel = state.riskFilter === "all" ? "all risks" : `${state.riskFilter} only`;

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      padding={1}
      gap={1}
      backgroundColor={tokens.bg}
    >
      <text content={headerContent} />
      <box width="100%" flexGrow={1} flexDirection="row" gap={1}>
        {showSidebar ? (
          <box
            width={sidebarWidth}
            height="100%"
            border
            borderColor={state.focus === "sidebar" ? tokens.borderFocus : tokens.borderSoft}
            backgroundColor={tokens.surface}
            paddingX={1}
          >
            <select
              focused={state.focus === "sidebar"}
              showDescription={false}
              showScrollIndicator
              wrapSelection={false}
              options={sidebarOptions}
              onSelect={(_, option) => {
                const value = option?.value ?? ALL_SCOPES_KEY;
                mutate((s) => setScopeFilter(s, value === ALL_SCOPES_KEY ? null : value));
                focusPanel("list");
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
              setFilterDraft(value);
              mutate((s) => setFilter(s, value));
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
            {state.focus !== "patterns" && groupHeaders.length > 0 ? (
              <text content={groupHeaders.map((h: { label: string }) => h.label).join("  ")} />
            ) : null}
            {state.focus === "patterns" ? (
              <select
                focused
                showDescription={false}
                showScrollIndicator
                wrapSelection={false}
                selectedIndex={listSelectIndex}
                options={patternOptions}
                onChange={(index) => mutate((s) => setRowIndex(s, index))}
                onSelect={(_, option) => {
                  if (option?.value) mutate((s) => togglePattern(s, option.value));
                }}
              />
            ) : visibleItems.length === 0 ? (
              <text content="No artifacts match the current filter." />
            ) : (
              <select
                focused={state.focus === "list"}
                showDescription={false}
                showScrollIndicator
                wrapSelection={false}
                selectedIndex={listSelectIndex}
                options={itemOptions}
                onChange={(index) => {
                  const candidate = visibleItems[index];
                  if (!candidate) return;
                  const rowIndex = displayRows.findIndex(
                    (row) => row.kind === "item" && row.candidateId === candidate.id,
                  );
                  if (rowIndex >= 0) mutate((s) => setRowIndex(s, rowIndex));
                }}
                onSelect={() => requestApply()}
              />
            )}
          </box>
          <text content={`risk filter: ${riskLabel} (1-4)`} />
        </box>
      </box>
      <text content={contextContent} />
      <text content={footerContent} />
      {showHelp ? <HelpOverlay tokens={tokens} /> : null}
      {pendingApply ? (
        <ConfirmOverlay
          tokens={tokens}
          selectedCount={summary.selectedCount}
          dangerousCount={dangerousSelected}
          {...(dryRun ? { dryRun: true } : {})}
        />
      ) : null}
    </box>
  );
}

export async function runSweepUi(
  plan: ScanPlan,
  options: SweepUiOptions = {},
): Promise<SweepUiOutcome> {
  if (options.yes) {
    return { type: "apply", plan };
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    useMouse: true,
    targetFps: 30,
  });

  return await new Promise<SweepUiOutcome>((resolvePromise, rejectPromise) => {
    const root = createRoot(renderer);
    const cleanup = () => {
      root.unmount();
      renderer.destroy();
    };
    try {
      root.render(
        <UiErrorBoundary>
          <SweepApp
            plan={plan}
            {...(options.dryRun ? { dryRun: true } : {})}
            {...(options.init ? { init: options.init } : {})}
            onDone={(outcome) => {
              cleanup();
              resolvePromise(outcome);
            }}
          />
        </UiErrorBoundary>,
      );
    } catch (error) {
      cleanup();
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** @deprecated Use SweepUiOutcome */
export type LegacySweepUiResult = ScanPlan | null;
