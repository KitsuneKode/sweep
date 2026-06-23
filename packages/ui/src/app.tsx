import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { StyledText } from "@opentui/core";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { Component, type ReactNode, useCallback, useMemo, useReducer, useState } from "react";
import { ReviewPane } from "./ReviewPane.js";
import { handleKeymap } from "./keymap.js";
import type { SweepUiOutcome } from "./outcome.js";
import { buildContextLine, buildFooterLine, buildHeaderLine } from "./presentation.js";
import { buildDisplayRows } from "./rows.js";
import {
  applyUiSelection,
  countSelectedDangerous,
  createUiState,
  getUiSummary,
  setFocus,
  toggleSelectionById,
  type SweepUiInitOptions,
  type SweepUiState,
} from "./state.js";
import { getVisibleCandidates } from "./state/selectors.js";
import { resolveTheme, type ThemeTokens } from "./theme.js";

export interface SweepUiOptions {
  yes?: boolean;
  dryRun?: boolean;
  init?: SweepUiInitOptions;
}

export type { SweepUiOutcome } from "./outcome.js";

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
  const candidatesById = useMemo(
    () => new Map(state.candidates.map((candidate) => [candidate.id, candidate])),
    [state.candidates],
  );

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

  const applyPlan = useCallback(() => {
    finalize({ type: "apply", plan: applyUiSelection(plan, state) });
  }, [finalize, plan, state]);

  useKeyboard((key) => {
    handleKeymap(
      {
        key,
        state,
        showHelp,
        pendingApply,
        showSidebar,
        listSelectIndex,
      },
      {
        finalize,
        mutate,
        focusPanel,
        setShowHelp,
        setPendingApply,
        requestApply,
        applyPlan,
      },
    );
  });

  const headerContent: StyledText = buildHeaderLine(plan, summary, tokens, dryRun);
  const contextContent: StyledText = buildContextLine(state, tokens);
  const footerContent: StyledText = buildFooterLine(
    state.focus,
    tokens,
    dryRun,
    state.patternsDirty,
  );

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
      <ReviewPane
        state={state}
        plan={plan}
        tokens={tokens}
        showSidebar={showSidebar}
        sidebarWidth={sidebarWidth}
        filterDraft={filterDraft}
        displayRows={displayRows}
        visibleItems={visibleItems}
        candidatesById={candidatesById}
        listSelectIndex={listSelectIndex}
        onFilterDraftChange={setFilterDraft}
        onMutate={mutate}
        onFocusPanel={focusPanel}
        onToggleSelection={(candidateId) => mutate((s) => toggleSelectionById(s, candidateId))}
      />
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
