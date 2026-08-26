import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { bold, fg, t } from "@opentui/core";
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
import {
  buildBrandLine,
  buildFooterLine,
  buildHeaderStats,
  buildRiskTally,
  formatScanProgressLine,
  modeLabel,
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
import { ModeChip, Modal } from "./widgets.js";
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
    t`${fg(tokens.text)(keys.padEnd(16))} ${fg(tokens.textMuted)(desc)}`;

  return (
    <Modal tokens={tokens} title=" keyboard " width={62}>
      <box flexDirection="column" gap={0}>
        <text content={line("↑↓ / j k", "move cursor")} />
        <text content={line("g / G", "jump to first / last")} />
        <text content={line("ctrl-u / ctrl-d", "half page up / down")} />
        <text content={line("h · l", "collapse · expand scope group")} />
        <text content={line("w · e", "collapse all · expand all")} />
        <text content={line("space", "queue / unqueue for deletion")} />
        <text content={line("a · s · u", "safe+caution · safe only · clear")} />
        <text content={line("o", "sort by size ↔ name")} />
        <text content={line("r", "rescan from disk")} />
        <text content={line("/ then tab", "filter · cycle panes (⇥ back)")} />
        <text content={line("1 – 4", "filter by risk level")} />
        <text content={line("p", "pattern editor")} />
        <text content={line("enter", "apply deletion (confirms when risky)")} />
        <text content={line("t", "cycle theme (dark · light · auto)")} />
        <text content={line("? · q", "close help · quit")} />
      </box>
      <text content="" />
      <text
        content={t`${fg(tokens.textDim)("esc walks back through views — it never quits. q quits.")}`}
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
  const [filterDraft, setFilterDraft] = useState("");
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
  const sidebarWidth = dimensions.width >= 110 ? 32 : dimensions.width >= 90 ? 28 : 24;
  const showSidebar = dimensions.width >= 72;

  const mutate = useCallback((fn: (s: SweepUiState) => SweepUiState) => {
    dispatch({
      type: "mutate",
      fn: (s) => {
        const next = fn(s);
        if (next.filter !== s.filter && next.filter.length === 0) {
          setFilterDraft("");
        }
        return next;
      },
    });
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
        pageRows: Math.max(6, dimensions.height - 9),
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
        clearFilterDraft: () => setFilterDraft(""),
        dismissScanError: () => setScanError(null),
      },
    );
  });

  const headerStats = buildHeaderStats(plan, summary, tokens, dryRun);

  const riskFilterLabel = state.riskFilter === "all" ? undefined : `${state.riskFilter} only`;

  const footerContent = buildFooterLine(state.focus, tokens, dryRun, state.patternsDirty, {
    scanning: state.scanning,
    queuedCount: state.selectedIds.size,
    candidateCount: state.candidates.length,
  });
  const tallyContent = buildRiskTally(summary, tokens);

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
      <box width="100%" flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text content={buildBrandLine(tokens)} />
        <box flexDirection="row" gap={2}>
          {state.scanning ? (
            <text
              content={t`${fg(tokens.accent)(formatScanProgressLine(state.candidates.length, state.scannedDirs))}`}
            />
          ) : null}
          <text content={headerStats} />
        </box>
      </box>

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

      {/* Statusline */}
      <box
        width="100%"
        flexDirection="row"
        alignItems="center"
        backgroundColor={tokens.statusBg}
        marginTop={1}
      >
        <ModeChip label={` ${modeLabel(state.focus, state.scanning)} `} tokens={tokens} />
        <box flexGrow={1} paddingLeft={1} flexDirection="row">
          <text content={footerContent} />
          {riskFilterLabel ? (
            <text content={t`  ${fg(tokens.warning)(`· risk: ${riskFilterLabel}`)}`} />
          ) : null}
          {state.sortBy === "name" ? (
            <text content={t`  ${fg(tokens.info)("· sorted by name")}`} />
          ) : null}
        </box>
        <box paddingRight={1}>
          <text content={tallyContent} />
        </box>
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

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    useMouse: true,
    targetFps: 30,
  });

  return await new Promise<SweepUiOutcome>((resolvePromise, rejectPromise) => {
    const root = createRoot(renderer);
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      process.removeListener("exit", onProcessExit);
      process.removeListener("uncaughtException", onProcessExit);
      try {
        root.unmount();
      } catch {
        // ignore
      }
      try {
        renderer.destroy();
      } catch {
        // ignore
      }
    };
    const onProcessExit = () => cleanup();
    process.once("exit", onProcessExit);
    process.once("uncaughtException", onProcessExit);

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
