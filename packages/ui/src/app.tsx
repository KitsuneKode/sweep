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
  resetForRescan,
  rescanConfigFromState,
  setFocus,
  setPatternInput,
  setScanning,
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

/** A help row, or a section break when `keys` is null. */
const HELP_ROWS: ReadonlyArray<readonly [keys: string | null, description: string]> = [
  [null, "move"],
  ["↑↓ / j k", "cursor (wheel scrolls too)"],
  ["g / G · home / end", "first / last row"],
  ["ctrl-u/d · pgup/dn", "page up · down"],
  ["h · l", "collapse · expand group"],
  ["w · e", "collapse all · expand all"],
  [null, "queue"],
  ["space", "queue / unqueue row"],
  ["v", "visual range - space queues it"],
  ["a · s · u", "safe+caution · safe only · clear"],
  ["enter", "apply (always asks to confirm)"],
  [null, "filter & view"],
  ["/", "filter - tab cycles panes"],
  ["kind:x risk:y >100MB older:30d", "filter syntax (+ is:queued, !term)"],
  ["1 - 4", "risk filter"],
  ["o", "sort size · name · age"],
  ["i", "inspect row"],
  ["tab", "scopes - space queues the scope"],
  ["y", "copy row path"],
  ["S", "save queue as a plan file"],
  [null, "patterns (p)"],
  ["space", "toggle pattern"],
  ["/", "filter the catalog"],
  ["a", "add a custom pattern"],
  ["d", "remove a custom pattern"],
  ["w / W", "write .sweeprc (W overwrites)"],
  ["r", "rescan with the new set"],
  [null, "app"],
  ["t", "theme dark · light · auto"],
  ["?", "this panel"],
  ["q · ctrl-c", "quit · quit now"],
];

const HELP_KEY_WIDTH =
  Math.max(...HELP_ROWS.map(([keys]) => (keys === null ? 0 : keys.length))) + 2;
/** Border (2) + horizontal padding (6) around the widest row. */
const HELP_WIDTH =
  HELP_KEY_WIDTH + Math.max(...HELP_ROWS.map(([, description]) => description.length)) + 8;

function HelpOverlay({ tokens }: { tokens: ThemeTokens }) {
  // Word wrap instead of clipping: on a narrow terminal a long row breaks
  // between words rather than losing its tail.
  return (
    <Modal tokens={tokens} title=" keyboard " width={HELP_WIDTH}>
      <box flexDirection="column" gap={0}>
        {HELP_ROWS.map(([keys, description]) =>
          keys === null ? (
            <text
              key={`section-${description}`}
              content={t`${bold(fg(tokens.accent)(description))}`}
              wrapMode="none"
            />
          ) : (
            <text
              key={keys}
              content={t`${fg(tokens.text)(keys.padEnd(HELP_KEY_WIDTH))}${fg(tokens.textMuted)(description)}`}
              wrapMode="word"
            />
          ),
        )}
      </box>
      <text content="" />
      <text
        content={t`${fg(tokens.textDim)("esc walks back a view. It never quits.")}`}
        wrapMode="word"
      />
      <text
        content={t`${fg(tokens.textDim)("ctrl-c always quits, from any pane or dialog.")}`}
        wrapMode="word"
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
        content={t`${fg(tokens.positive)(formatBytes(selectedBytes))} ${fg(tokens.textMuted)("will be freed")}`}
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
        {field("size", formatBytes(candidate.estimatedBytes))}
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
  const [pendingApply, setPendingApply] = useState(false);
  const [showInspect, setShowInspect] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // One-line feedback for keys that deliberately do nothing (esc with nothing
  // left to unwind, enter on an empty queue, space on a blocked row). Cleared
  // by the next real state change so it never lingers past its context.
  const [notice, setNotice] = useState<string | null>(null);

  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
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
    setScanError(null);
    dispatch({ type: "mutate", fn: (s) => setScanning(s, true) });
    scan.start(
      {
        onBatch: (candidates) => {
          if (gen !== generationRef.current || controller.signal.aborted) return;
          dispatch({ type: "mutate", fn: (s) => upsertCandidates(s, candidates) });
        },
        onProgress: ({ scannedDirs, skippedDirs }) => {
          if (gen !== generationRef.current || controller.signal.aborted) return;
          dispatch({
            type: "mutate",
            fn: (s) => setSkippedDirs(setScannedDirs(s, scannedDirs), skippedDirs),
          });
        },
        onDone: ({ scannedDirs, skippedDirs, plan: finalPlan }) => {
          if (gen !== generationRef.current || controller.signal.aborted) return;
          dispatch({
            type: "mutate",
            fn: (s) =>
              finalizeScan(setSkippedDirs(setScannedDirs(s, scannedDirs), skippedDirs), finalPlan),
          });
          // The scan chip quietly flipping to NORMAL is the only signal today -
          // say what landed so the end of a long scan is legible at a glance.
          const found = finalPlan?.candidates.length;
          setNotice(
            found !== undefined
              ? `scan complete: ${found} artifact${found === 1 ? "" : "s"} · ${scannedDirs.toLocaleString()} dirs`
              : `scan complete: ${scannedDirs.toLocaleString()} dirs`,
          );
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
    if (summary.selectedCount === 0) {
      setNotice("nothing queued: space on a row queues it");
      return;
    }
    // Every apply deletes real files - the confirm gate is not reserved for
    // dangerous tiers. The dialog tones down (no red banner) when nothing
    // dangerous is queued, but it is always there.
    setPendingApply(true);
  }, [summary]);

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

  const renderer = useRenderer();

  const exportPlan = useCallback(() => {
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
        notify: setNotice,
      },
    );
  });

  const inspectCandidate = useMemo(
    () => (showInspect ? getCurrentCandidate(state) : undefined),
    [showInspect, state],
  );

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
    engine,
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

  const footerContext: FooterContext = scanError
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

      {showHelp ? <HelpOverlay tokens={tokens} /> : null}
      {pendingApply ? (
        <ConfirmOverlay
          tokens={tokens}
          selectedCount={summary.selectedCount}
          selectedBytes={summary.selectedBytes}
          dangerousCount={dangerousSelected}
          previewPaths={confirmPreview}
          {...(dryRun ? { dryRun: true } : {})}
          {...(trashMode ? { trash: true } : {})}
        />
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
          <text content={t`${fg(tokens.danger)("The scan engine reported an error:")}`} />
          <text content="" />
          <text content={sanitizeTerminalText(scanError)} fg={tokens.text} />
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
