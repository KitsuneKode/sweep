import { bold, fg, StyledText, t } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { basename, join } from "node:path";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { writeProjectSweeprc } from "@kitsunekode/sweep-core/config";
import { assertSafePattern } from "@kitsunekode/sweep-core/guardrails";
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
import { darkTheme } from "./theme.js";
import type { SweepUiOutcome } from "./outcome.js";
import { writePlanExport } from "./plan-export.js";
import { openUiSession } from "./runtime.js";
import {
  buildBrandLine,
  buildContextLine,
  buildFooterHints,
  buildHeaderStats,
  buildRiskTally,
  modeLabel,
  relativePath,
  riskGlyph,
  type FooterContext,
} from "./presentation.js";
import { buildDisplayRows } from "./rows.js";
import {
  addCustomPattern,
  applyUiSelection,
  applyVisualRange,
  countSelectedDangerous,
  createUiState,
  finalizeScan,
  getCurrentCandidate,
  getUiSummary,
  mergeApplyReport,
  planForCandidateIds,
  resetForRescan,
  rescanConfigFromState,
  setFocus,
  setPatternInput,
  setScanning,
  setScanCurrentDir,
  sweeprcPayload,
  toggleSelectionById,
  toggleSidebarScopeSelection,
  toggleSortBy,
  setScannedDirs,
  setSkippedDirs,
  upsertCandidates,
  visualRange,
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
  /** Trash mode: the apply dialog must say "move", not "permanently delete". */
  trash?: boolean;
  /** Which scan backend produced the plan - shown as a dim header chip. */
  engine?: "js" | "rust";
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
  /** Trash mode - changes confirm copy and adds a TRASH header chip. */
  trash?: boolean;
  /** Which scan backend produced the plan - shown as a dim header chip. */
  engine?: "js" | "rust";
  onDone: (outcome: SweepUiOutcome) => void;
  init?: SweepUiInitOptions;
  /** When present, the app boots into a live scan and fills in as results stream. */
  scan?: UiScanControl;
  initiallyScanning?: boolean;
}

function styledContentFallback(message: string): ReactNode {
  // Renders when the app crashed before (or without) theme context - always
  // uses the dark palette directly rather than resolving a mode.
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      padding={1}
      backgroundColor={darkTheme.bg}
    >
      <text
        content={t`${bold(fg(darkTheme.danger)("◆ sweep"))} ${fg(darkTheme.textMuted)("hit an error in the interactive view")}`}
      />
      <text content="" />
      <text content={sanitizeTerminalText(message)} fg={darkTheme.text} />
      <text content="" />
      <text content="Press q or Ctrl+C to exit, then re-run with --no-ui." fg={darkTheme.textDim} />
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

/** A help row: keycap + what it does. Sections break on `keys === null`. */
type HelpRow = readonly [keys: string | null, description: string];

const HELP_MOVE: ReadonlyArray<HelpRow> = [
  [null, "move"],
  ["↑↓ / j k", "cursor · wheel scrolls"],
  ["g / G", "first / last row"],
  ["ctrl-u/d", "page up · down"],
  ["h · l", "collapse · expand group"],
  ["w · e", "collapse all · expand all"],
];

const HELP_QUEUE: ReadonlyArray<HelpRow> = [
  [null, "queue"],
  ["space", "queue / unqueue row"],
  ["v", "visual range - space queues"],
  ["a · s · u", "queue visible · safe · clear"],
  ["x · d", "delete just this row"],
  ["enter", "apply queue (always confirms)"],
];

const HELP_VIEW: ReadonlyArray<HelpRow> = [
  [null, "view"],
  ["/", "filter list · tab cycles panes"],
  ["1 - 4", "risk filter"],
  ["o", "sort size · name · age"],
  ["i", "inspect row"],
  ["y", "copy row path"],
  ["S", "save queue as a plan"],
];

const HELP_PATTERNS: ReadonlyArray<HelpRow> = [
  [null, "patterns (p)"],
  ["space", "toggle pattern"],
  ["/", "filter the catalog"],
  ["a · d", "add · remove custom"],
  ["w / W", "write .sweeprc (W force)"],
  ["r", "rescan with new set"],
];

const HELP_APP: ReadonlyArray<HelpRow> = [
  [null, "app"],
  ["tab", "scopes - space queues scope"],
  ["t", "theme dark · light · auto"],
  ["E", "swap scan engine js · rust"],
  ["q · ctrl-c", "quit · quit now"],
];

// Two columns split as move+queue+app | view+patterns so both land near the
// same height; a narrow terminal folds into a single column in reading order.
const HELP_LEFT: ReadonlyArray<HelpRow> = [...HELP_MOVE, ...HELP_QUEUE, ...HELP_APP];
const HELP_RIGHT: ReadonlyArray<HelpRow> = [...HELP_VIEW, ...HELP_PATTERNS];
const HELP_SINGLE: ReadonlyArray<HelpRow> = [
  ...HELP_MOVE,
  ...HELP_QUEUE,
  ...HELP_VIEW,
  ...HELP_PATTERNS,
  ...HELP_APP,
];

const HELP_FILTER_SYNTAX = "kind:x  risk:y  path:z  >100MB  older:30d  is:dir  is:file  !term";

/** Compact duration for scan timing chips/notices: 96ms, 1.2s, 2m 4s. */
function formatScanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms - minutes * 60_000) / 1000)}s`;
}

/**
 * Scan-timing fragment for the completion notice: `rust 96ms` alone, or
 * `rust 96ms vs js 214ms (2.2× faster)` once both engines have timed a run
 * on this tree.
 */
function engineTimingLabel(
  engine: "js" | "rust",
  durations: Partial<Record<"js" | "rust", number>>,
): string {
  const current = durations[engine];
  if (current === undefined) return engine;
  const otherEngine = engine === "rust" ? "js" : "rust";
  const other = durations[otherEngine];
  if (other === undefined) return `${engine} ${formatScanMs(current)}`;
  const ratio = other > 0 ? current / other : 1;
  const verdict =
    ratio < 0.95
      ? `${formatRatio(1 / ratio)} faster`
      : ratio > 1.05
        ? `${formatRatio(ratio)} slower`
        : "about equal";
  return `${engine} ${formatScanMs(current)} vs ${otherEngine} ${formatScanMs(other)} (${verdict})`;
}

function formatRatio(ratio: number): string {
  return ratio >= 10 ? `${Math.round(ratio)}×` : `${ratio.toFixed(1)}×`;
}

function helpColumn(rows: ReadonlyArray<HelpRow>, keyWidth: number, tokens: ThemeTokens) {
  return (
    <box flexDirection="column" flexShrink={0}>
      {rows.map(([keys, description], index) =>
        keys === null ? (
          <box key={`section-${description}`} flexDirection="column">
            <text content="" />
            <text
              content={t`${bold(fg(tokens.accent)(description.toUpperCase()))}`}
              wrapMode="none"
            />
          </box>
        ) : (
          <text
            // Index, not the keycap: "space" and "/" legitimately appear in
            // two sections, and single-column mode concatenates both columns.
            key={`${keys}-${index}`}
            content={t`${bold(fg(tokens.text)(keys.padEnd(keyWidth)))}${fg(tokens.textMuted)(description)}`}
            wrapMode="none"
          />
        ),
      )}
    </box>
  );
}

function HelpOverlay({ tokens, width }: { tokens: ThemeTokens; width: number }) {
  // Keys get the strong color, descriptions recede, section headers are the
  // only accent - the hierarchy reads at a glance instead of one gray wall.
  const keyWidth =
    Math.max(
      ...HELP_LEFT.map(([k]) => k?.length ?? 0),
      ...HELP_RIGHT.map(([k]) => k?.length ?? 0),
    ) + 2;
  const leftWidth = keyWidth + Math.max(...HELP_LEFT.map(([, d]) => d.length));
  const rightWidth = keyWidth + Math.max(...HELP_RIGHT.map(([, d]) => d.length));
  const twoColWidth = leftWidth + rightWidth + 4; // column gap

  // Modal chrome: 2 border + 6 paddingX + 2 scrollbox reserve. Budget for all
  // of it or the widest row clips against the right edge.
  const CHROME = 10;

  // Narrow terminals collapse to one column and drop the syntax sample -
  // better absent than wrapped mid-token.
  const singleWidth = Math.max(leftWidth, rightWidth);
  const twoCol = width >= twoColWidth + CHROME;
  const modalWidth = twoCol
    ? twoColWidth + CHROME
    : Math.min(singleWidth + CHROME, Math.max(28, width - 4));

  return (
    <Modal tokens={tokens} title=" keys " width={modalWidth}>
      {twoCol ? (
        <box flexDirection="row" gap={4}>
          {helpColumn(HELP_LEFT, keyWidth, tokens)}
          {helpColumn(HELP_RIGHT, keyWidth, tokens)}
        </box>
      ) : (
        helpColumn(HELP_SINGLE, keyWidth, tokens)
      )}
      <text content="" />
      {HELP_FILTER_SYNTAX.length + 8 <= modalWidth - CHROME ? (
        <text
          content={t`${fg(tokens.textDim)("filter")}  ${fg(tokens.textSecondary)(HELP_FILTER_SYNTAX)}`}
          wrapMode="none"
        />
      ) : null}
      <text
        content={t`${fg(tokens.textDim)("esc unwinds one layer, never quits · ctrl-c always quits")}`}
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
  previewPaths,
  dryRun,
  trash,
}: {
  tokens: ThemeTokens;
  selectedCount: number;
  selectedBytes: number;
  dangerousCount: number;
  /** Largest queued candidates by bytes - the last gate should name names. */
  previewPaths: string[];
  dryRun?: boolean;
  trash?: boolean;
}) {
  // The verb has to match what executePlanDeletion will actually do -
  // "permanently delete" while moving to trash understates nothing, and
  // "move" while deleting would be a lie the other way.
  const action = dryRun ? "Preview removal of" : trash ? "Move to trash" : "Permanently delete";
  const dangerous = dangerousCount > 0;
  const accent = dangerous && !trash ? tokens.danger : tokens.accent;
  const shown = previewPaths.slice(0, 3);
  const hidden = previewPaths.length - shown.length;

  return (
    <Modal
      tokens={tokens}
      title={dangerous ? " ⚠ apply " : " apply "}
      titleColor={accent}
      width={56}
    >
      <text
        content={t`${bold(fg(accent)(`${action} ${selectedCount} item${selectedCount === 1 ? "" : "s"}`))}`}
      />
      <text
        content={t`${fg(tokens.positive)(formatBytes(selectedBytes))} ${fg(tokens.textMuted)("estimated size")}`}
      />
      <text content="" />
      {shown.map((path) => (
        <text
          key={path}
          content={t`${fg(tokens.textDim)("·")} ${fg(tokens.textSecondary)(path)}`}
          wrapMode="none"
        />
      ))}
      {hidden > 0 ? (
        <text content={t`${fg(tokens.textDim)(`  …and ${hidden} more`)}`} wrapMode="none" />
      ) : null}
      <text content="" />
      {dangerous ? (
        <text
          content={t`${fg(trash ? tokens.warning : tokens.danger)(
            trash
              ? `⚠ ${dangerousCount} dangerous item${dangerousCount === 1 ? "" : "s"} leave the working tree.`
              : `⚠ ${dangerousCount} dangerous item${dangerousCount === 1 ? "" : "s"} selected. This cannot be undone.`,
          )}`}
        />
      ) : trash ? (
        <text
          content={t`${fg(tokens.textDim)("Moves into .sweep-trash-* under the target. Reversible.")}`}
        />
      ) : (
        <text content={t`${fg(tokens.textDim)("No dangerous items in this selection.")}`} />
      )}
      <text content="" />
      {dryRun ? null : (
        <text
          content={t`${bold(fg(tokens.text)("t"))} ${fg(tokens.textMuted)(trash ? "delete permanently instead" : "move to trash instead (reversible)")}`}
        />
      )}
      <text
        content={t`${bold(fg(tokens.text)("y"))} ${fg(tokens.textMuted)("confirm")}    ${bold(fg(tokens.text)("n"))}${fg(tokens.textMuted)(" / esc cancel")}`}
      />
    </Modal>
  );
}

/**
 * Per-candidate detail - the "why" behind a row. Reasons, entry type and the
 * full (sanitized) path never fit the list row; the list is for triage, this
 * is for trust.
 */
function InspectOverlay({
  tokens,
  candidate,
  queued,
  targetDir,
}: {
  tokens: ThemeTokens;
  candidate: ScanCandidate;
  queued: boolean;
  targetDir: string;
}) {
  const rel = relativePath(targetDir, candidate.path).replaceAll("\\", "/");
  const riskGlyphColor = {
    safe: tokens.positive,
    caution: tokens.warning,
    dangerous: tokens.danger,
    blocked: tokens.blocked,
  }[candidate.riskTier];

  const field = (label: string, value: string | StyledText) => (
    <box flexDirection="row" height={1} flexShrink={0}>
      <text content={t`${fg(tokens.textDim)(label.padEnd(9))} `} wrapMode="none" />
      {typeof value === "string" ? (
        <text content={t`${fg(tokens.text)(value)}`} wrapMode="none" />
      ) : (
        <text content={value} wrapMode="none" />
      )}
    </box>
  );

  return (
    <Modal tokens={tokens} title=" artifact " width={64}>
      <box flexDirection="column">
        <text
          content={t`${fg(riskGlyphColor)(riskGlyph[candidate.riskTier])} ${bold(fg(tokens.text)(sanitizeTerminalText(candidate.name)))} ${fg(tokens.textMuted)(candidate.kind)}`}
          wrapMode="none"
        />
        <text content="" />
        {field("path", sanitizeTerminalText(rel.length > 0 ? rel : candidate.name))}
        {field(
          "size",
          `${formatBytes(candidate.estimatedBytes)}${candidate.bytesKnown === false ? " (partial - unreadable subtree)" : ""}`,
        )}
        {field(
          "risk",
          t`${fg(riskGlyphColor)(candidate.riskTier)}${queued ? fg(tokens.accent)("  · queued") : ""}`,
        )}
        {field(
          "type",
          candidate.isSymlink
            ? `${candidate.entryType} (link only, target never scanned)`
            : candidate.entryType,
        )}
        {candidate.reasons.length > 0 ? (
          <>
            <text content="" />
            <text content={t`${fg(tokens.textDim)("why it was flagged:")}`} wrapMode="none" />
            {candidate.reasons.map((reason) => (
              <text
                key={reason}
                content={t`  ${fg(tokens.textDim)("·")} ${fg(tokens.textSecondary)(sanitizeTerminalText(reason))}`}
                wrapMode="none"
              />
            ))}
          </>
        ) : null}
        <text content="" />
        <text
          content={t`${bold(fg(tokens.text)("i"))} ${fg(tokens.textMuted)(" / esc close")}`}
          wrapMode="none"
        />
      </box>
    </Modal>
  );
}

export function SweepApp({
  plan,
  dryRun,
  trash,
  engine,
  onDone,
  init,
  scan,
  initiallyScanning,
}: SweepAppProps) {
  const [state, dispatch] = useReducer(uiReducer, plan, (p: ScanPlan) => createUiState(p, init));
  const [showHelp, setShowHelp] = useState(false);
  const [pendingApply, setPendingApplyState] = useState(false);
  // Non-null while the confirm dialog is scoped to one row (x/d): the same
  // dialog renders, but `y` applies only that candidate.
  const [pendingSingleId, setPendingSingleId] = useState<string | null>(null);
  // An in-session apply is running: keys trap (except ctrl-c = stop), and the
  // report merges back into the list instead of ending the session.
  const [applying, setApplying] = useState<string | null>(null);
  const applyAbortRef = useRef<AbortController | null>(null);
  const [showInspect, setShowInspect] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // One-line feedback for keys that deliberately do nothing (esc with nothing
  // left to unwind, enter on an empty queue, space on a blocked row). Cleared
  // by the next real state change so it never lingers past its context.
  const [notice, setNotice] = useState<string | null>(null);

  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // Engine the next scan generation runs (E flips it); the `engine` prop only
  // seeds the first generation. Timing per engine lives in scanDurationsRef
  // so the notice can compare backends on the same tree.
  const [activeEngine, setActiveEngine] = useState<"js" | "rust">(engine ?? "js");
  // Mirror in a ref - startScan is a useCallback and reads the engine at
  // start() time, so the E-toggle's setState must not race the closure.
  const activeEngineRef = useRef(activeEngine);
  const scanStartRef = useRef(0);
  // Ref carries the authoritative map (readable mid-callback); state mirrors
  // it so the header chip re-renders when a run's duration lands.
  const scanDurationsRef = useRef<Partial<Record<"js" | "rust", number>>>({});
  const [scanDurations, setScanDurations] = useState(scanDurationsRef.current);
  // Coarse ticker - the scanning strip's elapsed readout ticks at 4Hz while a
  // scan runs, independent of progress-event cadence (a slow dir would
  // otherwise freeze the readout).
  const [, setScanTick] = useState(0);
  const scanningNow = state.scanning;
  const stateRef = useRef(state);
  // The measured artifact-pane height, reported by the list's layout event.
  // Pageup/pagedown step real pages once known; the estimate below seeds it.
  const viewportRowsRef = useRef<number | null>(null);
  stateRef.current = state;

  // Live-scan lifecycle: boot into the first generation, restart on rescan.
  const startScan = useCallback(() => {
    if (!scan) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = ++generationRef.current;
    const engineForRun = activeEngineRef.current;
    const startedAt = performance.now();
    scanStartRef.current = startedAt;
    setScanError(null);
    dispatch({ type: "mutate", fn: (s) => setScanning(s, true) });
    scan.start(
      {
        onBatch: (candidates) => {
          if (gen !== generationRef.current || controller.signal.aborted) return;
          dispatch({ type: "mutate", fn: (s) => upsertCandidates(s, candidates) });
        },
        onProgress: ({ scannedDirs, skippedDirs, currentDir, sizedCount }) => {
          if (gen !== generationRef.current || controller.signal.aborted) return;
          dispatch({
            type: "mutate",
            fn: (s) => ({
              ...setScanCurrentDir(
                setSkippedDirs(setScannedDirs(s, scannedDirs), skippedDirs),
                currentDir ?? null,
              ),
              scanSizedCount: sizedCount ?? s.scanSizedCount,
            }),
          });
        },
        onDone: ({ scannedDirs, skippedDirs, plan: finalPlan }) => {
          if (gen !== generationRef.current || controller.signal.aborted) return;
          // Monotonic elapsed for this generation - excludes UI idle time and
          // any earlier aborted run, so js-vs-rust comparisons stay honest.
          const elapsedMs = Math.max(0, performance.now() - startedAt);
          scanDurationsRef.current = { ...scanDurationsRef.current, [engineForRun]: elapsedMs };
          setScanDurations(scanDurationsRef.current);
          // The scan chip quietly flipping to NORMAL is the only signal today
          // - say what landed so the end of a long scan is legible at a
          // glance, with the engine comparison the E-toggle is for.
          const found = finalPlan?.candidates.length;
          const base =
            found !== undefined
              ? `scan complete: ${found} artifact${found === 1 ? "" : "s"} · ${scannedDirs.toLocaleString()} dirs`
              : `scan complete: ${scannedDirs.toLocaleString()} dirs`;
          setNotice(
            `${base}${skippedDirs > 0 ? ` · ${skippedDirs} skipped (partial scan)` : ""} · ${engineTimingLabel(engineForRun, scanDurationsRef.current)}`,
          );
          dispatch({
            type: "mutate",
            fn: (s) =>
              finalizeScan(setSkippedDirs(setScannedDirs(s, scannedDirs), skippedDirs), finalPlan),
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
  }, [scan, activeEngine]);

  useEffect(() => {
    if (scan && initiallyScanning) startScan();
    return () => {
      abortRef.current?.abort();
    };
    // Boot-only effect; rescans are triggered explicitly via r.
  }, []);

  // 4Hz elapsed ticker, live only while a scan runs - progress events already
  // re-render the strip, this keeps the readout honest through a slow dir.
  useEffect(() => {
    if (!scanningNow) return;
    const id = setInterval(() => setScanTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [scanningNow]);

  const requestRescan = useCallback(() => {
    if (!scan) return;
    const { disabledPatterns, extraPatterns } = rescanConfigFromState(stateRef.current);
    scan.syncPatterns(disabledPatterns, extraPatterns);
    dispatch({ type: "mutate", fn: resetForRescan });
    startScan();
  }, [scan, startScan]);

  // E: swap scan engines and rescan the same tree - the completion notice
  // reports the new engine's time against any prior run so the faster backend
  // is legible at a glance, no benchmark harness required.
  const toggleEngine = useCallback(() => {
    if (!scan) {
      setNotice("engine switch needs a live scan - run `sweep ui`");
      return;
    }
    const next = activeEngine === "rust" ? "js" : "rust";
    if (!scan.setEngine(next)) {
      setNotice(`${next} engine unavailable - no sweep-engine binary resolved`);
      return;
    }
    // Ref first - startScan reads it synchronously; the setState is render
    // scheduling only.
    activeEngineRef.current = next;
    setActiveEngine(next);
    const { disabledPatterns, extraPatterns } = rescanConfigFromState(stateRef.current);
    scan.syncPatterns(disabledPatterns, extraPatterns);
    dispatch({ type: "mutate", fn: resetForRescan });
    startScan();
  }, [scan, activeEngine, startScan]);

  const tokens = useMemo(() => resolveTheme(state.themeMode), [state.themeMode]);
  const summary = useMemo(() => getUiSummary(state), [state]);
  const dimensions = useTerminalDimensions();
  const sidebarWidth = dimensions.width >= 110 ? 38 : dimensions.width >= 90 ? 32 : 26;
  const showSidebar = dimensions.width >= 72;

  const mutate = useCallback((fn: (s: SweepUiState) => SweepUiState) => {
    setNotice(null);
    dispatch({ type: "mutate", fn });
  }, []);

  const visibleItems = useMemo(() => getVisibleCandidates(state), [state]);
  const displayRows = useMemo(() => buildDisplayRows(state), [state]);
  const dangerousSelected = useMemo(() => countSelectedDangerous(state), [state]);
  const candidatesById = useMemo(
    () => new Map(state.candidates.map((candidate) => [candidate.id, candidate])),
    [state.candidates],
  );

  const finalize = useCallback(
    (outcome: SweepUiOutcome) => {
      abortRef.current?.abort();
      onDone(outcome);
    },
    [onDone],
  );

  const requestApply = useCallback(() => {
    if (state.scanning) {
      // The queue is a moving target while discovery streams: a confirm
      // dialog whose count grows under the user's eyes is a trap.
      setNotice("scan still running - wait or esc out");
      return;
    }
    if (state.scanIncomplete) {
      setNotice("scan incomplete: press r to retry before applying or saving");
      return;
    }
    if (summary.selectedCount === 0) {
      setNotice("nothing queued: space on a row queues it");
      return;
    }
    // Every apply deletes real files - the confirm gate is not reserved for
    // dangerous tiers. The dialog tones down (no red banner) when nothing
    // dangerous is queued, but it is always there.
    setPendingApply(true);
  }, [summary, state.scanning, state.scanIncomplete]);

  const focusPanel = useCallback(
    (focus: SweepUiState["focus"]) => {
      mutate((s) => setFocus(s, focus));
    },
    [mutate],
  );

  // Starts from `--trash`, but the confirm dialog can flip it: the last
  // moment before deleting is exactly when someone wants the reversible option.
  const [trashMode, setTrashMode] = useState(Boolean(trash));
  const toggleTrash = useCallback(() => setTrashMode((current) => !current), []);

  const applyPlan = useCallback(() => {
    finalize({
      type: "apply",
      plan: applyUiSelection(plan, state),
      ...(trashMode ? { trash: true } : {}),
    });
  }, [finalize, plan, state, trashMode]);

  // The keymap's dismiss path calls this for both dialog scopes - clearing
  // the dialog always drops a single-row scope too, or a later y would apply
  // a candidate the user stopped looking at.
  const setPendingApply = useCallback((pending: boolean) => {
    setPendingApplyState(pending);
    if (!pending) setPendingSingleId(null);
  }, []);

  /**
   * `x`/`d` on a row: confirm an apply scoped to exactly that candidate.
   * Same gates as the queued apply - a running or incomplete scan means the
   * row under the cursor is not the row the engine would see.
   */
  const requestSingleApply = useCallback(() => {
    const s = stateRef.current;
    if (s.scanning) {
      setNotice("scan still running - wait or esc out");
      return;
    }
    if (s.scanIncomplete) {
      setNotice("scan incomplete: press r to retry before applying");
      return;
    }
    const candidate = getCurrentCandidate(s);
    if (!candidate) {
      // Header rows and empty lists land here - x is per-artifact only.
      setNotice("x deletes one artifact - space queues, enter applies the queue");
      return;
    }
    if (candidate.riskTier === "blocked") {
      setNotice("⊘ protected path - blocked items can't be deleted");
      return;
    }
    setPendingSingleId(candidate.id);
    setPendingApplyState(true);
  }, []);

  const confirmSingle = useCallback(() => {
    const id = pendingSingleId;
    setPendingSingleId(null);
    if (!id) return;
    const candidate = stateRef.current.candidates.find((c) => c.id === id);
    if (!candidate) {
      setNotice("row already left the list - nothing to delete");
      return;
    }
    const singlePlan = planForCandidateIds(plan, stateRef.current, [id]);
    const applyFn = scan?.apply;
    if (!applyFn) {
      // Static-plan mode has no in-session channel: exit through the same
      // apply outcome a queued apply takes - identical safety pipeline.
      finalize({ type: "apply", plan: singlePlan, ...(trashMode ? { trash: true } : {}) });
      return;
    }
    if (dryRun) {
      setNotice(
        `dry run - would ${trashMode ? "move" : "delete"} ${sanitizeTerminalText(relativePath(stateRef.current.targetDir, candidate.path))} (${formatBytes(candidate.estimatedBytes)})`,
      );
      return;
    }

    const controller = new AbortController();
    applyAbortRef.current = controller;
    const name = sanitizeTerminalText(
      relativePath(stateRef.current.targetDir, candidate.path) || candidate.name,
    );
    setApplying(name);
    void (async () => {
      try {
        const result = await applyFn({
          plan: singlePlan,
          trash: trashMode,
          signal: controller.signal,
        });
        const merged = mergeApplyReport(stateRef.current, result.report);
        dispatch({ type: "replace", state: merged.state });
        const verb = result.trashDir ? "moved to trash" : "deleted";
        if (merged.failed > 0 && merged.removedIds.length === 0) {
          setNotice(
            `couldn't ${trashMode ? "move" : "delete"} ${name}: ${sanitizeTerminalText(merged.firstFailure ?? "revalidation failed")}`,
          );
        } else {
          const extra =
            merged.removedIds.length > 1 ? ` (+${merged.removedIds.length - 1} nested)` : "";
          const stopped =
            merged.interrupted || merged.unattempted > 0
              ? ` - stopped early, ${merged.unattempted} left`
              : "";
          const failures = merged.failed > 0 ? ` · ${merged.failed} failed` : "";
          setNotice(
            `${verb} ${name}${extra} · freed ${formatBytes(merged.freedBytes)}${failures}${stopped}`,
          );
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        setNotice(
          `couldn't ${trashMode ? "move" : "delete"} ${name}: ${sanitizeTerminalText(reason)}`,
        );
      } finally {
        applyAbortRef.current = null;
        setApplying(null);
      }
    })();
  }, [pendingSingleId, plan, scan, finalize, trashMode, dryRun]);

  const abortApply = useCallback(() => {
    applyAbortRef.current?.abort();
  }, []);

  const renderer = useRenderer();

  const exportPlan = useCallback(() => {
    if (state.scanning || state.scanIncomplete) {
      setNotice("scan incomplete: wait or press r to retry before saving");
      return;
    }
    if (summary.selectedCount === 0) {
      setNotice("nothing queued: space on a row queues it");
      return;
    }
    try {
      const file = writePlanExport(applyUiSelection(plan, state), process.cwd());
      setNotice(`plan saved: ${sanitizeTerminalText(basename(file))} (sweep apply --plan)`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setNotice(`couldn't save plan: ${sanitizeTerminalText(reason)}`);
    }
  }, [plan, state, summary.selectedCount]);

  const yankPath = useCallback(() => {
    const candidate = getCurrentCandidate(state);
    if (!candidate) {
      setNotice("nothing under the cursor");
      return;
    }
    const copied = renderer.copyToClipboardOSC52(candidate.path);
    setNotice(
      copied
        ? `copied ${sanitizeTerminalText(relativePath(state.targetDir, candidate.path))}`
        : "this terminal does not accept clipboard writes (OSC 52)",
    );
  }, [renderer, state]);

  const applyVisual = useCallback(() => {
    const result = applyVisualRange(stateRef.current);
    dispatch({ type: "replace", state: result.state });
    const skipped = result.skipped > 0 ? `, skipped ${result.skipped} dangerous or blocked` : "";
    if (result.queued > 0) setNotice(`queued ${result.queued}${skipped}`);
    else if (result.unqueued > 0) setNotice(`unqueued ${result.unqueued}${skipped}`);
    else setNotice(`nothing queueable in that range${skipped}`);
  }, []);

  const applyScopeToggle = useCallback(() => {
    const result = toggleSidebarScopeSelection(stateRef.current);
    dispatch({ type: "replace", state: result.state });
    const skipped = result.skipped > 0 ? `, skipped ${result.skipped} dangerous or blocked` : "";
    if (result.queued > 0) setNotice(`queued ${result.queued} in scope${skipped}`);
    else if (result.unqueued > 0) setNotice(`unqueued ${result.unqueued} in scope${skipped}`);
    else setNotice(`nothing queueable in that scope${skipped}`);
  }, []);

  /**
   * Enter on the pattern pane's add line. Validates through the same
   * assertSafePattern the config file loader uses - a pattern the file would
   * reject never enters state from the editor either.
   */
  const submitPatternDraft = useCallback(() => {
    const draft = stateRef.current.patternDraft.trim();
    if (!draft) {
      dispatch({ type: "mutate", fn: (s) => setPatternInput(s, null) });
      return;
    }
    try {
      assertSafePattern(draft);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setNotice(`invalid pattern: ${sanitizeTerminalText(reason)}`);
      return;
    }
    if (stateRef.current.catalogPatterns.includes(draft)) {
      // Already catalogued - enabling it is a toggle, not a duplicate row.
      dispatch({ type: "mutate", fn: (s) => setPatternInput(s, null) });
      setNotice(`"${sanitizeTerminalText(draft)}" is in the catalog - space toggles it`);
      return;
    }
    dispatch({
      type: "mutate",
      fn: (s) => addCustomPattern(setPatternInput(s, null), draft),
    });
    setNotice(`added "${sanitizeTerminalText(draft)}" - r rescans with it`);
  }, []);

  /**
   * `w` in the pattern pane persists the current toggle set as a project
   * .sweeprc. An existing file is never clobbered silently - plain w reports
   * it, shift-W overwrites deliberately.
   */
  const writeSweeprc = useCallback((overwrite: boolean) => {
    const s = stateRef.current;
    const configPath = join(s.targetDir, ".sweeprc");
    try {
      const result = writeProjectSweeprc(configPath, sweeprcPayload(s), overwrite);
      if (result === "exists") {
        setNotice(".sweeprc already exists - shift-W overwrites it");
      } else {
        setNotice(`${result === "updated" ? "updated" : "wrote"} .sweeprc`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setNotice(`couldn't write .sweeprc: ${sanitizeTerminalText(reason)}`);
    }
  }, []);

  useKeyboard((key) => {
    handleKeymap(
      {
        key,
        state,
        showHelp,
        pendingApply,
        showSidebar,
        scanError,
        inspectOpen: showInspect,
        pendingSingle: pendingSingleId !== null,
        applying: applying !== null,
        // Measured list rows once the pane has laid out; the height-minus-
        // chrome estimate only seeds the first frame before a size event.
        pageRows: viewportRowsRef.current ?? Math.max(6, dimensions.height - 10),
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
        toggleEngine,
        toggleSort: () => dispatch({ type: "mutate", fn: toggleSortBy }),
        dismissScanError: () => setScanError(null),
        setInspect: setShowInspect,
        toggleTrash,
        exportPlan,
        yankPath,
        applyVisual,
        applyScopeToggle,
        writeSweeprc,
        submitPatternDraft,
        requestSingleApply,
        confirmSingle,
        abortApply,
        notify: setNotice,
      },
    );
  });

  const inspectCandidate = useMemo(
    () => (showInspect ? getCurrentCandidate(state) : undefined),
    [showInspect, state],
  );

  // The inspected candidate can disappear mid-overlay (rescan, filter change):
  // without this the overlay unmounts while inspectOpen keeps trapping keys.
  useEffect(() => {
    if (showInspect && !inspectCandidate) setShowInspect(false);
  }, [showInspect, inspectCandidate]);

  // The sidebar unmounts under a narrow terminal; focus must not survive
  // into a pane that no longer exists - the keymap does the same reconcile
  // for the pre-effect window.
  useEffect(() => {
    if (!showSidebar && state.focus === "sidebar") focusPanel("list");
  }, [showSidebar, state.focus, focusPanel]);

  const confirmPreview = useMemo(
    () =>
      state.candidates
        .filter(
          (candidate) => state.selectedIds.has(candidate.id) && candidate.riskTier !== "blocked",
        )
        .sort((a, b) => b.estimatedBytes - a.estimatedBytes)
        .slice(0, 3)
        .map((candidate) =>
          sanitizeTerminalText(relativePath(state.targetDir, candidate.path).replaceAll("\\", "/")),
        ),
    [state.candidates, state.selectedIds, state.targetDir],
  );

  const headerStats = buildHeaderStats(
    plan,
    summary,
    tokens,
    dryRun,
    dimensions.width,
    trashMode,
    // Compact chip: `rust·263ms` once timed; the full js-vs-rust verdict lives
    // in the completion notice, the header just needs the current backend.
    scanDurations[activeEngine] !== undefined
      ? `${activeEngine}·${formatScanMs(scanDurations[activeEngine]!)}`
      : activeEngine,
  );

  const riskFilterLabel = state.riskFilter === "all" ? undefined : `${state.riskFilter} only`;
  // The sidebar is the scope filter's control surface, and it hides under 72
  // cols - without a chip the list is silently filtered with no way to see why
  // (esc still clears it).
  const scopeFilterLabel =
    state.scopeFilter === null
      ? undefined
      : state.scopeFilter === ""
        ? "project root"
        : state.scopeFilter;

  // Overlays cover the panes but not the statusline, so the footer has to
  // describe whatever is actually on top or the user is left with no visible
  // way out of a modal.
  const visualActive = state.focus === "list" && visualRange(state) !== null;

  const pendingSingleCandidate =
    pendingSingleId === null ? undefined : candidatesById.get(pendingSingleId);

  const footerContext: FooterContext =
    applying !== null
      ? { kind: "applying" }
      : scanError
        ? { kind: "scanError" }
        : pendingApply
          ? { kind: "confirm" }
          : showInspect
            ? { kind: "inspect" }
            : showHelp
              ? { kind: "help" }
              : visualActive
                ? { kind: "visual" }
                : { kind: "pane", focus: state.focus };

  const footerContent = buildFooterHints(footerContext, tokens, {
    ...(dryRun ? { dryRun: true } : {}),
    ...(state.patternsDirty ? { patternsDirty: true } : {}),
    ...(dimensions.width < 72 ? { compact: true } : {}),
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
        <text content={buildBrandLine(tokens, dimensions.width)} wrapMode="none" />
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
          onMutate={mutate}
          onFocusPanel={focusPanel}
          onToggleSelection={(candidateId) => mutate((s) => toggleSelectionById(s, candidateId))}
          onSubmitPatternDraft={submitPatternDraft}
          onViewportRows={(rows) => {
            viewportRowsRef.current = rows;
          }}
          {...(state.scanning
            ? { scanElapsedMs: Math.max(0, performance.now() - scanStartRef.current) }
            : {})}
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
        <text
          content={notice ? t`${fg(tokens.warning)(notice)}` : buildContextLine(state, tokens)}
          wrapMode="none"
        />
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
        ) : state.scanIncomplete ? (
          <ModeChip label=" INCOMPLETE " tokens={tokens} />
        ) : (
          <ModeChip label={` ${modeLabel(state.focus, false, visualActive)} `} tokens={tokens} />
        )}
        <box flexGrow={1} flexShrink={0} paddingLeft={1} flexDirection="row">
          <text content={footerContent} wrapMode="none" />
          {roomForChips && riskFilterLabel ? (
            <text
              content={t`  ${fg(tokens.warning)(`· risk: ${riskFilterLabel}`)}`}
              wrapMode="none"
            />
          ) : null}
          {roomForChips && scopeFilterLabel ? (
            <text
              content={t`  ${fg(tokens.info)(`· scope: ${sanitizeTerminalText(scopeFilterLabel)}`)}`}
              wrapMode="none"
            />
          ) : null}
          {roomForChips && state.sortBy !== "size" ? (
            <text
              content={t`  ${fg(tokens.info)(`· sorted by ${state.sortBy}`)}`}
              wrapMode="none"
            />
          ) : null}
        </box>
        {roomForTally ? (
          <box paddingLeft={2} paddingRight={1} flexShrink={1}>
            <text content={tallyContent} wrapMode="none" />
          </box>
        ) : null}
      </box>

      {showHelp ? <HelpOverlay tokens={tokens} width={dimensions.width} /> : null}
      {pendingApply ? (
        pendingSingleCandidate ? (
          <ConfirmOverlay
            tokens={tokens}
            selectedCount={1}
            selectedBytes={pendingSingleCandidate.estimatedBytes}
            dangerousCount={pendingSingleCandidate.riskTier === "dangerous" ? 1 : 0}
            previewPaths={[
              sanitizeTerminalText(
                relativePath(state.targetDir, pendingSingleCandidate.path).replaceAll("\\", "/"),
              ),
            ]}
            {...(dryRun ? { dryRun: true } : {})}
            {...(trashMode ? { trash: true } : {})}
          />
        ) : (
          <ConfirmOverlay
            tokens={tokens}
            selectedCount={summary.selectedCount}
            selectedBytes={summary.selectedBytes}
            dangerousCount={dangerousSelected}
            previewPaths={confirmPreview}
            {...(dryRun ? { dryRun: true } : {})}
            {...(trashMode ? { trash: true } : {})}
          />
        )
      ) : null}
      {applying !== null ? (
        <Modal tokens={tokens} title=" applying " titleColor={tokens.info} width={52}>
          <text
            content={t`${fg(tokens.text)("Removing ")}${bold(fg(tokens.text)(applying))}`}
            wrapMode="none"
          />
          <text content="" />
          <text
            content={t`${fg(tokens.textMuted)("in-flight work finishes; no new deletes schedule")}`}
            wrapMode="none"
          />
          <text
            content={t`${bold(fg(tokens.text)("ctrl-c"))} ${fg(tokens.textMuted)("stop now - the report still lands")}`}
          />
        </Modal>
      ) : null}
      {showInspect && inspectCandidate ? (
        <InspectOverlay
          tokens={tokens}
          candidate={inspectCandidate}
          queued={state.selectedIds.has(inspectCandidate.id)}
          targetDir={state.targetDir}
        />
      ) : null}
      {scanError ? (
        <Modal tokens={tokens} title=" scan error " titleColor={tokens.danger} width={60}>
          <text
            // Engine errors arrive prefixed ("error: ...") - redundant inside a
            // dialog already titled "scan error".
            content={sanitizeTerminalText(scanError.replace(/^[Ee]rror:\s*/, ""))}
            fg={tokens.text}
          />
          <text content="" />
          <text
            content={t`${bold(fg(tokens.text)("r"))} ${fg(tokens.textMuted)("retry scan")}    ${bold(fg(tokens.text)("esc"))} ${fg(tokens.textMuted)("dismiss")}    ${bold(fg(tokens.text)("q"))}${fg(tokens.textMuted)(" quit")}`}
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
          {...(options.trash ? { trash: true } : {})}
          {...(options.engine ? { engine: options.engine } : {})}
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
