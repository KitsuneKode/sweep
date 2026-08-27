import { bold, fg, t } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { ReviewPane } from "./ReviewPane.js";
import { handleKeymap } from "./keymap.js";
import type { SweepUiOutcome } from "./outcome.js";
import { openUiSession } from "./runtime.js";
import {
  buildBrandLine,
  buildContextLine,
  buildFooterHints,
  buildHeaderStats,
  buildRiskTally,
  modeLabel,
  type FooterContext,
} from "./presentation.js";
import { buildDisplayRows } from "./rows.js";
import {
  applyUiSelection,
  countSelectedDangerous,
  createUiState,
  getUiSummary,
  resetForRescan,
  rescanConfigFromState,
  setFocus,
  setScanning,
  toggleSelectionById,
  toggleSortBy,
  setScannedDirs,
  upsertCandidates,
  type SweepUiInitOptions,
  type SweepUiState,
} from "./state.js";
import { getVisibleCandidates } from "./state/selectors.js";
import { resolveTheme, type ThemeTokens } from "./theme.js";
import { ModeChip, ScanModeChip, Modal } from "./widgets.js";
import type { UiScanControl } from "./streaming.js";

export { runSweepUiStreaming } from "./streaming.js";
export type { SweepUiStreamingOptions } from "./streaming.js";

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
  /** When present, the app boots into a live scan and fills in as results stream. */
  scan?: UiScanControl;
  initiallyScanning?: boolean;
}

function styledContentFallback(message: string): ReactNode {
  return (
    <box width="100%" height="100%" flexDirection="column" padding={1} backgroundColor="#090b10">
      <text
        content={t`${bold(fg("#f87171")("◆ sweep"))} ${fg("#64748b")("— the interactive view hit an error")}`}
      />
      <text content="" />
      <text content={message} fg="#e2e8f0" />
      <text content="" />
      <text content="Press q or Ctrl+C to exit, then re-run with --no-ui." fg="#64748b" />
    </box>
  );
}

export class UiErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
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
  const line = (keys: string, desc: string) =>
    t`${fg(tokens.text)(keys.padEnd(20))} ${fg(tokens.textMuted)(desc)}`;

  return (
    <Modal tokens={tokens} title=" keyboard " width={72}>
      <box flexDirection="column" gap={0}>
        <text content={line("↑↓ / j k", "move cursor (skips headings)")} wrapMode="none" />
        <text content={line("g / G", "jump to first / last")} wrapMode="none" />
        <text content={line("ctrl-u / ctrl-d", "half page up / down")} wrapMode="none" />
        <text content={line("h · l", "collapse · expand the folder")} wrapMode="none" />
        <text content={line("w · e", "collapse all · expand all")} wrapMode="none" />
        <text content={line("space", "queue / unqueue for deletion")} wrapMode="none" />
        <text content={line("a · s · u", "safe+caution · safe only · clear")} wrapMode="none" />
        <text content={line("o", "sort by size ↔ name")} wrapMode="none" />
        <text content={line("r", "rescan from disk")} wrapMode="none" />
        <text content={line("/ then tab", "filter · cycle panes (⇥ back)")} wrapMode="none" />
        <text content={line("1 – 4", "filter by risk level")} wrapMode="none" />
        <text content={line("p", "pattern editor")} wrapMode="none" />
        <text content={line("enter", "apply (confirms when risky)")} wrapMode="none" />
        <text content={line("t", "cycle theme (dark · light · auto)")} wrapMode="none" />
        <text content={line("? · q · ctrl-c", "help · quit · quit")} wrapMode="none" />
      </box>
      <text content="" />
      <text
        content={t`${fg(tokens.textDim)("esc walks back a view — it never quits.")}`}
        wrapMode="none"
      />
      <text
        content={t`${fg(tokens.textDim)("ctrl-c always quits, from any pane or dialog.")}`}
        wrapMode="none"
      />
    </Modal>
  );
}

function ConfirmOverlay({
  tokens,
  selectedCount,
  selectedBytes,
  dangerousCount,
  dryRun,
}: {
  tokens: ThemeTokens;
  selectedCount: number;
  selectedBytes: number;
  dangerousCount: number;
  dryRun?: boolean;
}) {
  const action = dryRun ? "Preview deletion of" : "Permanently delete";
  const dangerous = dangerousCount > 0;
  const accent = dangerous ? tokens.danger : tokens.accent;

  return (
    <Modal
      tokens={tokens}
      title={dangerous ? " ⚠ apply " : " apply "}
      titleColor={accent}
      width={52}
    >
      <text
        content={t`${bold(fg(accent)(`${action} ${selectedCount} item${selectedCount === 1 ? "" : "s"}`))}`}
      />
      <text
        content={t`${fg(tokens.positive)(formatBytes(selectedBytes))} ${fg(tokens.textMuted)("will be freed")}`}
      />
      <text content="" />
      {dangerous ? (
        <text
          content={t`${fg(tokens.danger)(`⚠ ${dangerousCount} dangerous item${dangerousCount === 1 ? "" : "s"} selected — this cannot be undone.`)}`}
        />
      ) : (
        <text content={t`${fg(tokens.textDim)("No dangerous items in this selection.")}`} />
      )}
      <text content="" />
      <text
        content={t`${bold(fg(tokens.text)("y"))} ${fg(tokens.textMuted)("confirm")}    ${bold(fg(tokens.text)("n"))}${fg(tokens.textMuted)(" / esc cancel")}`}
      />
    </Modal>
  );
}

export function SweepApp({ plan, dryRun, onDone, init, scan, initiallyScanning }: SweepAppProps) {
  const [state, dispatch] = useReducer(uiReducer, plan, (p: ScanPlan) => createUiState(p, init));
  const [showHelp, setShowHelp] = useState(false);
  const [pendingApply, setPendingApply] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Live-scan lifecycle: boot into the first generation, restart on rescan.
  const startScan = useCallback(() => {
    if (!scan) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = ++generationRef.current;
    setScanError(null);
    dispatch({ type: "mutate", fn: (s) => setScanning(s, true) });
    scan.start(
      {
        onBatch: (candidates) => {
          if (gen !== generationRef.current || controller.signal.aborted) return;
          dispatch({ type: "mutate", fn: (s) => upsertCandidates(s, candidates) });
        },
        onProgress: ({ scannedDirs }) => {
          if (gen !== generationRef.current || controller.signal.aborted) return;
          dispatch({ type: "mutate", fn: (s) => setScannedDirs(s, scannedDirs) });
        },
        onDone: ({ scannedDirs }) => {
          if (gen !== generationRef.current || controller.signal.aborted) return;
          dispatch({
            type: "mutate",
            fn: (s) => setScanning(setScannedDirs(s, scannedDirs), false),
          });
        },
        onError: (error) => {
          if (gen !== generationRef.current || controller.signal.aborted) return;
          dispatch({ type: "mutate", fn: (s) => setScanning(s, false) });
          setScanError(error instanceof Error ? error.message : String(error));
        },
      },
      controller.signal,
    );
  }, [scan]);

  useEffect(() => {
    if (scan && initiallyScanning) startScan();
    return () => {
      abortRef.current?.abort();
    };
    // Boot-only effect; rescans are triggered explicitly via r.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestRescan = useCallback(() => {
    if (!scan) return;
    const { disabledPatterns, extraPatterns } = rescanConfigFromState(stateRef.current);
    scan.syncPatterns(disabledPatterns, extraPatterns);
    dispatch({ type: "mutate", fn: resetForRescan });
    startScan();
  }, [scan, startScan]);

  const tokens = useMemo(() => resolveTheme(state.themeMode), [state.themeMode]);
  const summary = useMemo(() => getUiSummary(state), [state]);
  const dimensions = useTerminalDimensions();
  const sidebarWidth = dimensions.width >= 110 ? 38 : dimensions.width >= 90 ? 32 : 26;
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
    if (state.focus === "patterns") return state.patternIndex;
    const currentId = displayRows[state.rowIndex];
    if (!currentId || currentId.kind !== "item") return 0;
    const idx = visibleItems.findIndex((c: ScanCandidate) => c.id === currentId.candidateId);
    return idx >= 0 ? idx : 0;
  }, [state, displayRows, visibleItems]);

  const finalize = useCallback(
    (outcome: SweepUiOutcome) => {
      abortRef.current?.abort();
      onDone(outcome);
    },
    [onDone],
  );

  const requestApply = useCallback(() => {
    if (summary.selectedCount === 0) return;
    if (dangerousSelected > 0) {
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
        scanError,
        // Approximate visible list rows: full height minus header/status chrome.
        pageRows: Math.max(6, dimensions.height - 10),
      },
      {
        finalize,
        mutate,
        focusPanel,
        setShowHelp,
        setPendingApply,
        requestApply,
        applyPlan,
        requestRescan,
        toggleSort: () => dispatch({ type: "mutate", fn: toggleSortBy }),
        dismissScanError: () => setScanError(null),
      },
    );
  });

  const headerStats = buildHeaderStats(plan, summary, tokens, dryRun);

  const riskFilterLabel = state.riskFilter === "all" ? undefined : `${state.riskFilter} only`;

  // Overlays cover the panes but not the statusline, so the footer has to
  // describe whatever is actually on top or the user is left with no visible
  // way out of a modal.
  const footerContext: FooterContext = scanError
    ? { kind: "scanError" }
    : pendingApply
      ? { kind: "confirm" }
      : showHelp
        ? { kind: "help" }
        : { kind: "pane", focus: state.focus };

  const footerContent = buildFooterHints(footerContext, tokens, {
    ...(dryRun ? { dryRun: true } : {}),
    ...(state.patternsDirty ? { patternsDirty: true } : {}),
  });
  const tallyContent = buildRiskTally(summary, tokens);
  // Below this width the tally and the risk/sort chips crowd the key hints out
  // of the statusline entirely; the hints are the part that must survive.
  const roomForTally = dimensions.width >= 84;
  const roomForChips = dimensions.width >= 100;

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      backgroundColor={tokens.bg}
    >
      {/* Header band */}
      <box
        width="100%"
        flexShrink={0}
        height={1}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text content={buildBrandLine(tokens)} wrapMode="none" />
        <text content={headerStats} wrapMode="none" />
      </box>

      <box width="100%" flexGrow={1} minHeight={0} flexShrink={1}>
        <ReviewPane
          state={state}
          plan={plan}
          tokens={tokens}
          showSidebar={showSidebar}
          sidebarWidth={sidebarWidth}
          displayRows={displayRows}
          visibleItems={visibleItems}
          candidatesById={candidatesById}
          listSelectIndex={listSelectIndex}
          onMutate={mutate}
          onFocusPanel={focusPanel}
          onToggleSelection={(candidateId) => mutate((s) => toggleSelectionById(s, candidateId))}
        />
      </box>

      <box
        width="100%"
        height={1}
        flexShrink={0}
        flexDirection="row"
        paddingLeft={1}
        backgroundColor={tokens.bg}
      >
        <text content={buildContextLine(state, tokens)} wrapMode="none" />
      </box>

      <box
        width="100%"
        height={1}
        flexShrink={0}
        flexDirection="row"
        alignItems="center"
        backgroundColor={tokens.statusBg}
      >
        {state.scanning ? (
          <ScanModeChip tokens={tokens} />
        ) : (
          <ModeChip label={` ${modeLabel(state.focus, false)} `} tokens={tokens} />
        )}
        <box flexGrow={1} flexShrink={0} paddingLeft={1} flexDirection="row">
          <text content={footerContent} wrapMode="none" />
          {roomForChips && riskFilterLabel ? (
            <text
              content={t`  ${fg(tokens.warning)(`· risk: ${riskFilterLabel}`)}`}
              wrapMode="none"
            />
          ) : null}
          {roomForChips && state.sortBy === "name" ? (
            <text content={t`  ${fg(tokens.info)("· sorted by name")}`} wrapMode="none" />
          ) : null}
        </box>
        {roomForTally ? (
          <box paddingRight={1} flexShrink={1}>
            <text content={tallyContent} wrapMode="none" />
          </box>
        ) : null}
      </box>

      {showHelp ? <HelpOverlay tokens={tokens} /> : null}
      {pendingApply ? (
        <ConfirmOverlay
          tokens={tokens}
          selectedCount={summary.selectedCount}
          selectedBytes={summary.selectedBytes}
          dangerousCount={dangerousSelected}
          {...(dryRun ? { dryRun: true } : {})}
        />
      ) : null}
      {scanError ? (
        <Modal tokens={tokens} title=" scan error " titleColor={tokens.danger} width={60}>
          <text content={t`${fg(tokens.danger)("The scan engine reported an error:")}`} />
          <text content="" />
          <text content={scanError} fg={tokens.text} />
          <text content="" />
          <text
            content={t`${bold(fg(tokens.text)("r"))} ${fg(tokens.textMuted)("retry scan")}    ${bold(fg(tokens.text)("q"))}${fg(tokens.textMuted)(" quit")}`}
          />
        </Modal>
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

  const session = await openUiSession();
  try {
    session.root.render(
      <UiErrorBoundary>
        <SweepApp
          plan={plan}
          {...(options.dryRun ? { dryRun: true } : {})}
          {...(options.init ? { init: options.init } : {})}
          onDone={session.finish}
        />
      </UiErrorBoundary>,
    );
  } catch (error) {
    session.finish({ type: "abort" });
    throw error instanceof Error ? error : new Error(String(error));
  }
  return await session.done;
}

/** @deprecated Use SweepUiOutcome */
export type LegacySweepUiResult = ScanPlan | null;
