import { fg, type KeyEvent, t } from "@opentui/core";
import {
  flushSync,
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import type { ApplyProgress, ScanPlan } from "@kitsunekode/sweep-protocol";
import { statfsSync } from "node:fs";
import { basename, join } from "node:path";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { writeProjectSweeprc, projectSweeprcRevision } from "@kitsunekode/sweep-core/config";
import { assertSafePattern, isApplyRefusedError } from "@kitsunekode/sweep-core/guardrails";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { buildActionMenuCommands } from "./action-menu.js";
import {
  ActionMenuModal,
  ConfigSaveModal,
  FolderInfoModal,
  PatternInfoModal,
  ScanErrorModal,
  UnavailableItemModal,
  type ConfigSaveState,
  type FolderInfoState,
} from "./AppModals.js";
import { ApplyOverlay } from "./ApplyOverlay.js";
import { ConfirmOverlay, type DiskSpace } from "./ConfirmOverlay.js";
import { FilterPicker } from "./FilterPicker.js";
import { FolderJump } from "./FolderJump.js";
import { HelpOverlay, ProjectsHelp } from "./HelpOverlay.js";
import { InspectOverlay } from "./InspectOverlay.js";
import { KeyHints } from "./KeyHints.js";
import { LedgerBand, type LedgerReceipt } from "./LedgerBand.js";
import { ProjectsView } from "./ProjectsView.js";
import { ReviewPane } from "./ReviewPane.js";
import { UiErrorBoundary } from "./UiErrorBoundary.js";
import {
  calmHintItems,
  displayTargetPath,
  formatScanMs,
  uiReducer,
  type ModalKind,
  type Notice,
} from "./app-helpers.js";
import { candidateIndex } from "./candidate-index.js";
import { rankConfirmPreview } from "./confirm-preview.js";
import {
  clearFacets,
  facetOptions,
  facetTallies,
  readFacets,
  toggleFacet,
} from "./filter-facets.js";
import { rankJumpTargets, type JumpTarget } from "./folder-jump.js";
import { handleKeymap, type KeyInput } from "./keymap.js";
import { MotionContext, motionEnabledFromEnvironment } from "./motion.js";
import { UiOperationSession } from "./operation-session.js";
import type { SweepUiOutcome } from "./outcome.js";
import { writePlanExport } from "./plan-export.js";
import {
  applyNotice,
  buildBrandLine,
  buildContextLine,
  buildHeaderStats,
  buildRiskTally,
  fitStatusLine,
  footerHintItems,
  modeLabel,
  relativePath,
  styledWidth,
  type FooterContext,
} from "./presentation.js";
import { rebuildSummary } from "./project-details.js";
import type { Project } from "./projects.js";
import { captureReviewedApply } from "./reviewed-apply.js";
import { buildDisplayRows } from "./rows.js";
import { noteCtrlCHandled, registerUiApplyCancellation } from "./runtime.js";
import {
  addCustomPattern,
  applyUiSelection,
  applyVisualRange,
  createUiState,
  getCurrentCandidate,
  getUiSummary,
  idleSafeCandidates,
  mergeApplyReport,
  patternAtCursor,
  selectSafeOnly,
  setFilter,
  setFocus,
  setPatternInput,
  setRiskFilter,
  sweeprcPayload,
  toggleScopeSelection,
  toggleSelectionById,
  toggleSidebarScopeSelection,
  toggleSortBy,
  visualRange,
  type SweepUiInitOptions,
  type SweepUiState,
} from "./state.js";
import { getVisibleCandidates } from "./state/selectors.js";
import type { FolderSwitcher, UiScanControl } from "./streaming.js";
import { noticeColor, resolveTheme, type NoticeTone } from "./theme.js";
import { useLiveScan } from "./useLiveScan.js";
import { useProjectsController } from "./useProjectsController.js";
import type { ViewPreferences } from "./view-preferences.js";
import { ModeChip, ScanModeChip } from "./widgets.js";

export { runSweepUiStreaming } from "./streaming.js";
export type { SweepUiStreamingOptions } from "./streaming.js";
export type { SweepUiOutcome } from "./outcome.js";
export { UiErrorBoundary };
export type { DiskSpace };

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
  operations?: UiOperationSession;
  preferences?: ViewPreferences;
  onPreferencesChange?: (value: ViewPreferences) => void;
  /** ctrl-o: switch the folder under review. Absent for static plans. */
  folders?: FolderSwitcher;
  initialNotice?: string;
  /**
   * "projects": the calm default - one row per project, grouped by idle time.
   * "folders": the full review (folder tree, columns, legend). `b` switches.
   */
  initialView?: "projects" | "folders";
  /**
   * The terminal's background, asked before the first frame. When given, the
   * app does not ask again and its first frame already has the right theme.
   */
  terminalBackground?: string | null;
  /** `--theme` with no saved preferences yet. */
  initialTheme?: "auto" | "dark" | "light";
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
  operations: suppliedOperations,
  preferences,
  onPreferencesChange,
  folders,
  initialNotice,
  initialView = "folders",
  terminalBackground: knownBackground,
  initialTheme,
}: SweepAppProps) {
  const [state, dispatch] = useReducer(uiReducer, plan, (p: ScanPlan) =>
    createUiState(p, {
      ...(preferences ? { themeMode: preferences.themeMode, sortBy: preferences.sortBy } : {}),
      ...(initialTheme ? { themeMode: initialTheme } : {}),
      ...init,
      startUnselected: init?.startUnselected ?? true,
    }),
  );
  const [showHelp, setShowHelpState] = useState(false);
  const [showFilter, setShowFilterState] = useState(false);
  const [filterCursor, setFilterCursor] = useState(0);
  const filterCursorRef = useRef(0);
  const [showMenu, setShowMenuState] = useState(false);
  const [showJump, setShowJumpState] = useState(false);
  const [jumpTargets, setJumpTargets] = useState<JumpTarget[]>([]);
  const [jumpQuery, setJumpQuery] = useState("");
  const jumpQueryRef = useRef("");
  const [jumpCursor, setJumpCursor] = useState(0);
  const jumpCursorRef = useRef(0);
  const [jumpError, setJumpError] = useState<string | null>(null);
  const [configSave, setConfigSave] = useState<ConfigSaveState | null>(null);
  const configSaveRef = useRef<ConfigSaveState | null>(null);
  const configSaveReadyRef = useRef(false);
  const [patternInfo, setPatternInfo] = useState<string | null>(null);
  useEffect(() => {
    configSaveReadyRef.current = configSave !== null;
  }, [configSave]);

  const [folderInfo, setFolderInfo] = useState<FolderInfoState | null>(null);
  const [menuCursor, setMenuCursor] = useState(0);
  const menuCursorRef = useRef(0);
  const [menuQuery, setMenuQuery] = useState("");
  const menuQueryRef = useRef("");
  const [motionEnabled, setMotionEnabled] = useState(
    () => motionEnabledFromEnvironment() && (preferences?.motionEnabled ?? true),
  );
  const motionEnabledRef = useRef(motionEnabled);
  useEffect(() => {
    onPreferencesChange?.({
      version: 1,
      themeMode: state.themeMode,
      sortBy: state.sortBy,
      motionEnabled,
    });
  }, [state.themeMode, state.sortBy, motionEnabled, onPreferencesChange]);

  const [pendingApply, setPendingApplyState] = useState(false);
  const [reviewedApply, setReviewedApply] = useState<ScanPlan | null>(null);
  const reviewedApplyRef = useRef<ScanPlan | null>(null);
  const [sizeLimitOverridden, setSizeLimitOverridden] = useState(false);
  const sizeLimitOverrideRef = useRef(false);
  const [reviewedOutsideView, setReviewedOutsideView] = useState(0);
  // Non-null while the confirm dialog is scoped to one row (x/d): the same
  // dialog renders, but `y` applies only that candidate.
  const [pendingSingleId, setPendingSingleIdState] = useState<string | null>(null);
  /**
   * A confirm scoped to one project's removable items (`x` on a project row),
   * not the whole queue. Other queued items stay queued either way.
   */
  const pendingScopeRef = useRef<{ ids: readonly string[]; label: string } | null>(null);
  const pendingSingleIdRef = useRef<string | null>(null);
  const setPendingSingleId = (id: string | null) => {
    pendingSingleIdRef.current = id;
    setPendingSingleIdState(id);
  };
  // Inspect pins identity across streaming/sort changes; x must never follow a
  // cursor that moved underneath the displayed detail overlay.
  const inspectedIdRef = useRef<string | null>(null);
  // An in-session apply is running: keys trap (except ctrl-c = stop), and the
  // report merges back into the list instead of ending the session.
  const [applying, setApplyingState] = useState<string | null>(null);
  // What the last apply gave back; the ledger shows it until the next queue.
  const [receipt, setReceipt] = useState<LedgerReceipt | null>(null);
  // Why each item of the last removal failed, by path. Failed items stay
  // queued, so the reason has to live where the item is, not in a notice.
  const [applyFailures, setApplyFailures] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    // A new scan makes the old reasons stale.
    if (state.scanning) setApplyFailures((current) => (current.size === 0 ? current : new Map()));
  }, [state.scanning]);
  const applyAbortRef = useRef<AbortController | null>(null);
  const closeAfterApplyRef = useRef(false);
  const [applyProgress, setApplyProgress] = useState<ApplyProgress | null>(null);
  const [showInspect, setShowInspectState] = useState(false);
  const [scanError, setScanErrorState] = useState<string | null>(null);
  // One-line feedback, cleared by the next real state change so it never
  // lingers past its context. Warning is the default and the original job:
  // keys that deliberately do nothing (esc with nothing left to unwind, enter
  // on an empty queue, space on a blocked row). Outcomes that went as asked
  // are "success"; plain information is "neutral", so amber keeps meaning
  // "look at this".
  // A folder switch arrives with a one-line note (where we are, config warnings).
  const [notice, setNoticeState] = useState<Notice | null>(
    initialNotice
      ? { text: initialNotice, tone: initialNotice.startsWith("config:") ? "warning" : "neutral" }
      : null,
  );
  const setNotice = useCallback((text: string | null, tone: NoticeTone = "warning") => {
    setNoticeState(text === null ? null : { text, tone });
  }, []);

  /**
   * Which overlay is live, tracked synchronously in a ref. useState/useReducer
   * values only commit at render, so two keypresses inside one stdin drain
   * (a paste burst, tmux send-keys, SSH packet coalescing) both see the
   * pre-burst flags - `i`+`enter` would open inspect AND arm the confirm
   * underneath it, letting an unseen `y` delete. The mask is written in the
   * setter call itself, so a second open in the same drain sees the first.
   */
  const openModalsRef = useRef(new Set<ModalKind>());
  const openModal = (kind: ModalKind): boolean => {
    if (openModalsRef.current.size > 0) return false;
    openModalsRef.current.add(kind);
    if (kind === "confirm") confirmReadyRef.current = false;
    return true;
  };
  const closeModal = (kind: ModalKind): void => {
    openModalsRef.current.delete(kind);
    if (kind === "confirm") confirmReadyRef.current = false;
  };
  // Elapsed time cannot authorize an unseen destructive confirmation.
  // Commit arms it; dismissal always remains available during a slow frame.
  const confirmReadyRef = useRef(false);

  const stateRef = useRef(state);
  // The measured artifact-pane height, reported by the list's layout event.
  // Pageup/pagedown step real pages once known; the estimate below seeds it.
  const viewportRowsRef = useRef<number | null>(null);
  stateRef.current = state;

  /**
   * Commit queued reducer mutations, then read post-commit state. Under
   * ConcurrentRoot a dispatch only applies at the next render, so handlers
   * that branch on state (which row is focused, is a scan running) must
   * flush first or a same-drain burst decides on stale rows.
   */
  const readFreshState = (): SweepUiState => {
    flushSync();
    return stateRef.current;
  };

  // Modal setters keep the ref mask in sync. Key-opened overlays
  // (help/inspect/confirm) refuse when another overlay is live so a burst
  // can't arm an unseen confirm; push overlays (scanError/applying) preempt
  // unconditionally - the keymap precedence already traps input under them.
  const setShowHelp = (open: boolean) => {
    if (open) {
      if (!openModal("help")) {
        setNotice("finish this dialog first");
        return;
      }
      setShowHelpState(true);
    } else {
      closeModal("help");
      setShowHelpState(false);
    }
  };
  const setInspect = (open: boolean, candidateId?: string) => {
    if (open) {
      if (!openModal("inspect")) {
        setNotice("finish this dialog first");
        return;
      }
      inspectedIdRef.current = candidateId ?? getCurrentCandidate(readFreshState())?.id ?? null;
      setShowInspectState(true);
    } else {
      closeModal("inspect");
      inspectedIdRef.current = null;
      setShowInspectState(false);
    }
  };
  const setPendingApply = (pending: boolean): boolean => {
    if (pending) {
      if (!openModal("confirm")) {
        setNotice("finish this dialog first");
        return false;
      }
      sizeLimitOverrideRef.current = false;
      setSizeLimitOverridden(false);
      try {
        const fresh = readFreshState();
        const captured = captureReviewedApply(
          plan,
          fresh,
          pendingSingleIdRef.current !== null
            ? [pendingSingleIdRef.current]
            : (pendingScopeRef.current?.ids ?? fresh.selectedIds),
        );
        reviewedApplyRef.current = captured;
        setReviewedApply(captured);
        const visibleIds = new Set(getVisibleCandidates(fresh).map((candidate) => candidate.id));
        setReviewedOutsideView(
          captured.candidates.filter((candidate) => !visibleIds.has(candidate.id)).length,
        );
      } catch (error) {
        closeModal("confirm");
        setPendingSingleId(null);
        pendingScopeRef.current = null;
        setNotice(sanitizeTerminalText(error instanceof Error ? error.message : String(error)));
        return false;
      }
      setPendingApplyState(true);
      setNotice(null);
    } else {
      closeModal("confirm");
      setPendingApplyState(false);
      setPendingSingleId(null);
      pendingScopeRef.current = null;
      reviewedApplyRef.current = null;
      setReviewedApply(null);
      setReviewedOutsideView(0);
      sizeLimitOverrideRef.current = false;
      setSizeLimitOverridden(false);
    }
    return true;
  };
  const setScanError = (message: string | null) => {
    if (message === null) closeModal("scanError");
    else {
      // A removal review must not sit under the error and come back armed.
      // Other dialogs (a pattern save, help) stay, and return when this closes.
      if (openModalsRef.current.has("confirm")) setPendingApply(false);
      openModalsRef.current.add("scanError"); // preemptor - must trap input
    }
    setScanErrorState(message);
  };
  const setApplying = (verb: string | null) => {
    if (verb === null) closeModal("applying");
    else openModalsRef.current.add("applying"); // preemptor
    setApplyingState(verb);
  };

  const { activeEngine, scanStartRef, scanDurations, requestRescan, toggleEngine, abortScan } =
    useLiveScan({
      scan,
      initiallyScanning,
      engine,
      scanningNow: state.scanning,
      dispatch,
      readFreshState,
      setScanError,
      setNotice,
    });

  // The terminal's own background, asked once: the canvas adopts it (colour,
  // opacity) and every tint is mixed from it. Unanswered, the brand canvas stays.
  const renderer = useRenderer();
  const [terminalBackground, setTerminalBackground] = useState<string | null>(
    knownBackground ?? null,
  );
  useEffect(() => {
    // Already asked before the first frame: asking again could only flash.
    if (knownBackground !== undefined) return;
    let live = true;
    try {
      renderer
        .getPalette({ timeout: 300 })
        .then((palette) => {
          const background = palette.defaultBackground;
          if (live && background && /^#[0-9a-f]{6}$/i.test(background))
            setTerminalBackground(background);
        })
        .catch(() => {});
    } catch {
      /* suspended or headless: keep the brand canvas */
    }
    return () => {
      live = false;
    };
  }, [renderer, knownBackground]);
  const tokens = useMemo(
    () => resolveTheme(state.themeMode, terminalBackground),
    [state.themeMode, terminalBackground],
  );
  const summary = useMemo(() => getUiSummary(state), [state]);
  // The first-steps line under the calm list stays until something is queued.
  const [everQueued, setEverQueued] = useState(false);
  useEffect(() => {
    if (summary.selectedCount > 0) setEverQueued(true);
  }, [summary.selectedCount > 0]);
  // A receipt describes the last removal; queueing again starts a new story.
  useEffect(() => {
    if (summary.selectedCount > 0) setReceipt(null);
  }, [summary.selectedCount > 0]);
  const dimensions = useTerminalDimensions();
  const sidebarWidth =
    dimensions.width >= 140 ? 48 : dimensions.width >= 110 ? 38 : dimensions.width >= 90 ? 32 : 26;
  const showSidebar = dimensions.width >= 72;

  const mutate = useCallback(
    (fn: (s: SweepUiState) => SweepUiState) => {
      // Every user-input mutation funnels here: keymap actions AND mouse paths
      // (row clicks, wheel, scrollbar drag via onSeek). While an overlay is
      // live, input belongs to it - a captured scrollbar drag surviving a
      // modal open would otherwise keep moving a cursor nobody can see, and
      // the next destructive key would land on the wrong row. Async dispatches
      // (scan batches, apply merges) use `dispatch` directly and stay ungated.
      if (openModalsRef.current.size > 0) return;
      setNotice(null);
      dispatch({ type: "mutate", fn });
    },
    [setNotice],
  );

  const visibleItems = useMemo(() => getVisibleCandidates(state), [state]);

  // The volume as it was before the last apply: `disk` only re-reads after a
  // scan or an apply, so during one it still holds the earlier reading.
  const diskRef = useRef<DiskSpace | null>(null);
  const disk = useMemo((): DiskSpace | null => {
    try {
      const stats = statfsSync(state.targetDir);
      return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
    } catch {
      return null;
    }
    // Re-read after a scan or an apply, not on every keystroke.
  }, [state.targetDir, state.scanning, receipt]);
  diskRef.current = disk;

  // Facet counts describe the current folder scope, before any filter, so
  // they hold still while options are toggled.
  const scopeCandidates = useMemo(
    () => getVisibleCandidates({ ...state, filter: "", riskFilter: "all" }),
    [state.candidates, state.scopeFilter, state.targetDir],
  );
  const filterOptions = useMemo(() => facetOptions(scopeCandidates), [scopeCandidates]);
  const filterTallies = useMemo(
    () => (showFilter ? facetTallies(scopeCandidates, filterOptions, state.selectedIds) : []),
    [showFilter, scopeCandidates, filterOptions, state.selectedIds],
  );
  const toggleFilterOption = (index: number) => {
    const option = filterOptions[index];
    if (!option || !openModalsRef.current.has("filter")) return;
    filterCursorRef.current = index;
    setFilterCursor(index);
    applyFilterEdit((current) => toggleFacet(current, option));
  };
  /**
   * The picker is the one overlay whose job is to edit state, and only the
   * filter string. `mutate` refuses input while any overlay is open, so the
   * picker dispatches this narrow edit itself - nothing else can ride along.
   */
  const applyFilterEdit = (edit: (filter: string) => string) => {
    if (!openModalsRef.current.has("filter") || openModalsRef.current.size !== 1) return;
    dispatch({ type: "mutate", fn: (s) => setFilter(s, edit(s.filter)) });
  };
  const displayRows = useMemo(() => buildDisplayRows(state), [state]);
  const candidatesById = useMemo(() => candidateIndex(state.candidates), [state.candidates]);

  const [operations] = useState(() => suppliedOperations ?? new UiOperationSession());
  const finalizedRef = useRef(false);
  const finalize = useCallback(
    (outcome: SweepUiOutcome) => {
      if (finalizedRef.current) return;
      finalizedRef.current = true;
      abortScan();
      onDone(operations.outcome(outcome));
    },
    [abortScan, onDone, operations],
  );

  const requestApply = () => {
    // Branch on post-commit state: a same-burst toggle/selection key can be
    // queued-but-unapplied, and gating on the stale snapshot either wrongly
    // refuses ("nothing queued") or opens a confirm showing older counts.
    const s = readFreshState();
    if (s.scanning) {
      // The queue is a moving target while discovery streams: a confirm
      // dialog whose count grows under the user's eyes is a trap.
      setNotice("scan still running - wait or esc out");
      return;
    }
    if (s.scanIncomplete) {
      setNotice("scan incomplete: press r to retry before applying or saving");
      return;
    }
    if (getUiSummary(s).selectedCount === 0) {
      setNotice("Queue is empty · choose Queue safe items, or Space for one item");
      return;
    }
    // Every apply deletes real files - the confirm gate is not reserved for
    // dangerous tiers. The dialog tones down (no red banner) when nothing
    // dangerous is queued, but it is always there.
    setPendingApply(true);
  };

  /**
   * `mutate`, committed before returning. Input-mode changes decide how the
   * next key routes, and a burst ("/node", a paste) dispatches every key before
   * React's default-lane render - only a dispatch inside `flushSync` commits in
   * time for the following key to see it.
   */
  const commitMutation = useCallback(
    (fn: (s: SweepUiState) => SweepUiState) => {
      if (openModalsRef.current.size > 0) return;
      flushSync(() => {
        setNotice(null);
        dispatch({ type: "mutate", fn });
      });
    },
    [setNotice],
  );

  const focusPanel = useCallback(
    (focus: SweepUiState["focus"]) => {
      commitMutation((s) => setFocus(s, focus));
    },
    [commitMutation],
  );

  // The dialog can change the initial --trash mode before confirmation.
  const [trashMode, setTrashMode] = useState(Boolean(trash));
  const trashModeRef = useRef(Boolean(trash));
  const toggleTrash = useCallback(() => {
    trashModeRef.current = !trashModeRef.current;
    setTrashMode(trashModeRef.current);
  }, []);

  const toggleSizeLimitOverride = () => {
    if (
      !openModalsRef.current.has("confirm") ||
      !confirmReadyRef.current ||
      renderer.width < 40 ||
      renderer.height < 12
    )
      return;
    if (
      !scan?.applyPolicy ||
      scan.applyPolicy.maxSizeGB === null ||
      scan.applyPolicy.forceLarge ||
      dryRun
    ) {
      setNotice("This review has no configurable size ceiling");
      return;
    }
    sizeLimitOverrideRef.current = !sizeLimitOverrideRef.current;
    setSizeLimitOverridden(sizeLimitOverrideRef.current);
  };

  // Forward ref to viewRef for runInSessionApply closure (populated below by useProjectsController).
  const currentViewRef = useRef<"projects" | "folders">(initialView);

  const runInSessionApply = useCallback(
    (scopedPlan: ScanPlan, name: string, explicitSingleSelection = false) => {
      // This ref closes the scheduling gate synchronously, before another key
      // in this stdin drain can confirm, quit, rescan or mutate the queue.
      if (applyAbortRef.current || operations.closing) return;
      const requestedTrash = trashModeRef.current;
      const requestedSizeOverride = sizeLimitOverrideRef.current;
      const applyFn = scan?.apply;
      if (!applyFn) {
        finalize({
          type: "apply",
          plan: scopedPlan,
          trash: requestedTrash,
          ...(requestedSizeOverride ? { overrideSizeLimit: true } : {}),
          ...(explicitSingleSelection ? { explicitSingleSelection: true } : {}),
        });
        return;
      }
      if (dryRun) {
        setNotice(`dry run - would ${requestedTrash ? "move" : "delete"} ${name}`, "neutral");
        return;
      }
      const controller = new AbortController();
      applyAbortRef.current = controller;
      setApplyProgress({
        stage: "preparing",
        selectedCount: scopedPlan.selectedCandidateIds.length,
        deletedCount: 0,
        estimatedBytesFreed: 0,
        elapsedMs: 0,
      });
      setApplying(name);
      void (async () => {
        let receivedReport = false;
        try {
          const result = await operations.run(
            {
              plan: scopedPlan,
              trash: requestedTrash,
              ...(requestedSizeOverride ? { overrideSizeLimit: true } : {}),
              ...(explicitSingleSelection ? { explicitSingleSelection: true } : {}),
              signal: controller.signal,
              onProgress: (progress) => {
                if (applyAbortRef.current !== controller) return;
                setApplyProgress({
                  ...progress,
                  stage: controller.signal.aborted ? "stopping" : progress.stage,
                });
              },
            },
            applyFn,
          );
          receivedReport = true;
          if (applyAbortRef.current !== controller) return;
          const merged = mergeApplyReport(stateRef.current, result.report);
          dispatch({ type: "replace", state: merged.state });
          const stopped = result.interrupted || merged.interrupted || merged.unattempted > 0;
          // What the disk actually gained, next to the estimate: hardlinked
          // installs (pnpm, bun) and other volumes free less than they weigh.
          let diskGained: number | undefined;
          try {
            const before = diskRef.current;
            const after = statfsSync(stateRef.current.targetDir);
            if (before && !result.trashDir) diskGained = after.bavail * after.bsize - before.free;
          } catch {
            diskGained = undefined;
          }
          setApplyFailures(
            new Map(result.report.failedPaths.map((failure) => [failure.path, failure.error])),
          );
          setReceipt({
            ...(diskGained !== undefined ? { diskGained } : {}),
            removed: merged.removedIds.length,
            failed: merged.failed,
            unattempted: merged.unattempted,
            freedBytes: merged.freedBytes,
            trash: Boolean(result.trashDir),
            stopped,
          });
          const clean = !stopped && merged.failed === 0;
          // The calm view says a clean result in its answer line; the notice
          // stays for anything that went wrong, and in the full view.
          if (!clean || currentViewRef.current !== "projects")
            setNotice(
              applyNotice({
                removed: merged.removedIds.length,
                what: scopedPlan.selectedCandidateIds.length === 1 ? name : undefined,
                trash: Boolean(result.trashDir),
                freedBytes: merged.freedBytes,
                stillQueued: getUiSummary(merged.state).selectedCount,
                failed: merged.failed,
                unattempted: merged.unattempted,
                stopped,
                firstFailure: merged.firstFailure
                  ? sanitizeTerminalText(merged.firstFailure)
                  : undefined,
              }),
              stopped || merged.failed > 0 ? "warning" : "success",
            );
        } catch (error) {
          if (applyAbortRef.current !== controller) return;
          if (receivedReport) {
            operations.viewFailed(error);
            finalize({ type: "abort" });
            return;
          }
          if (isApplyRefusedError(error)) {
            setNotice(`Nothing removed · ${sanitizeTerminalText(error.message)} · queue preserved`);
            return;
          }
          // With no authoritative report, retained rows may already be gone.
          // Require a rescan rather than allowing an automatic destructive retry.
          dispatch({ type: "replace", state: { ...stateRef.current, scanIncomplete: true } });
          setNotice(
            `apply outcome unavailable: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))} · rescan before applying again`,
          );
        } finally {
          if (applyAbortRef.current === controller) {
            applyAbortRef.current = null;
            setApplying(null);
            setApplyProgress(null);
            if (closeAfterApplyRef.current) finalize({ type: "abort" });
          }
        }
      })();
    },
    [scan, finalize, dryRun, operations, setNotice],
  );

  const applyPlan = useCallback(() => {
    const fresh = readFreshState();
    if (fresh.scanning || fresh.scanIncomplete) return;
    const selectedPlan = reviewedApplyRef.current;
    if (!selectedPlan || pendingSingleIdRef.current !== null) return;
    if (selectedPlan.selectedCandidateIds.length === 0) return;
    const scope = pendingScopeRef.current;
    runInSessionApply(
      selectedPlan,
      scope ? scope.label : `${selectedPlan.selectedCandidateIds.length} queued artifacts`,
    );
  }, [runInSessionApply]);

  /**
   * `x` on a project row: confirm the project's removable items only (safe
   * and caution, never dangerous or blocked), whatever else is queued.
   */
  const requestProjectApply = (project: Project) => {
    const s = readFreshState();
    if (s.scanning) {
      setNotice("scan still running - wait or esc out");
      return;
    }
    if (s.scanIncomplete) {
      setNotice("scan incomplete: press r to retry before applying");
      return;
    }
    if (project.queueable.length === 0) {
      setNotice(
        project.dangerous > 0
          ? "only dangerous items here: open the project and press x on one to review it"
          : "nothing removable in this project",
      );
      return;
    }
    pendingScopeRef.current = {
      ids: project.queueable,
      label: sanitizeTerminalText(project.name),
    };
    if (!setPendingApply(true)) pendingScopeRef.current = null;
  };

  /**
   * `x`/`d` on a row: confirm an apply scoped to exactly that candidate.
   * Same gates as the queued apply - a running or incomplete scan means the
   * row under the cursor is not the row the engine would see.
   */
  const requestSingleApply = (inspectedId?: string) => {
    // Flush first: j+x in one stdin drain must scope the dialog to the row
    // the cursor actually lands on, not the pre-move row.
    const s = readFreshState();
    if (s.scanning) {
      setNotice("scan still running - wait or esc out");
      return;
    }
    if (s.scanIncomplete) {
      setNotice("scan incomplete: press r to retry before applying");
      return;
    }
    const candidate =
      inspectedId === undefined
        ? getCurrentCandidate(s)
        : s.candidates.find((c) => c.id === inspectedId);
    if (!candidate) {
      // Header rows and empty lists land here - x is per-artifact only.
      setNotice(
        inspectedId === undefined
          ? "x reviews one artifact · Space queues · c reviews the queue"
          : "viewed artifact is no longer present - nothing to delete",
      );
      return;
    }
    if (candidate.riskTier === "blocked") {
      setNotice("⊘ protected path - blocked items can't be deleted");
      return;
    }
    setPendingSingleId(candidate.id);
    if (!setPendingApply(true)) setPendingSingleId(null);
  };

  const idleSafe = useMemo(
    () => idleSafeCandidates({ candidates: state.candidates }),
    [state.candidates],
  );
  const idleSafeBytes = idleSafe.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0);

  const {
    view,
    viewRef,
    setView,
    projects,
    byCost,
    projectRows,
    projectCursor,
    handleProjectKey,
    handleProjectCursorDelta,
    handleProjectRowPress,
  } = useProjectsController({
    initialView,
    visibleItems,
    selectedIds: state.selectedIds,
    targetDir: state.targetDir,
    scanning: state.scanning,
    viewportHeight: dimensions.height,
    idleSafeCount: idleSafe.length,
    idleSafeBytes,
    mutate,
    setNotice,
    setInspect,
    requestSingleApply,
    requestProjectApply,
  });
  currentViewRef.current = view;

  const confirmSingle = useCallback(() => {
    const id = pendingSingleIdRef.current;
    setPendingSingleId(null);
    if (!id) return;
    flushSync();
    const candidate = stateRef.current.candidates.find((c) => c.id === id);
    if (!candidate) {
      setNotice("row already left the list - nothing to delete");
      return;
    }
    const singlePlan = reviewedApplyRef.current;
    if (
      !singlePlan ||
      singlePlan.selectedCandidateIds.length !== 1 ||
      singlePlan.selectedCandidateIds[0] !== id
    ) {
      setNotice("Reviewed item is unavailable; nothing will be removed");
      return;
    }
    const name = sanitizeTerminalText(
      relativePath(singlePlan.targetDir, singlePlan.candidates[0]!.path) ||
        singlePlan.candidates[0]!.name,
    );
    runInSessionApply(singlePlan, name, true);
  }, [runInSessionApply, setNotice]);

  const confirmReviewedApply = () => {
    if (renderer.width < 40 || renderer.height < 12) {
      setNotice("Resize to at least 40 columns and 12 rows to review before confirming");
      return;
    }
    if (!openModalsRef.current.has("confirm") || !confirmReadyRef.current || applyAbortRef.current)
      return;
    if (pendingSingleIdRef.current !== null) confirmSingle();
    else applyPlan();
    setPendingApply(false);
  };

  const setFilterPicker = (open: boolean) => {
    if (open) {
      if (!openModal("filter")) return;
      filterCursorRef.current = 0;
      setFilterCursor(0);
    } else closeModal("filter");
    setShowFilterState(open);
  };

  const setJump = (open: boolean) => {
    if (open) {
      if (!folders || !openModal("jump")) return;
      jumpQueryRef.current = "";
      jumpCursorRef.current = 0;
      setJumpQuery("");
      setJumpCursor(0);
      setJumpError(null);
      // One bounded look around per open; typing only re-ranks it.
      setJumpTargets(folders.list());
    } else closeModal("jump");
    setShowJumpState(open);
  };
  const jumpResults = useMemo(
    () => (showJump ? rankJumpTargets(jumpTargets, jumpQuery, state.targetDir) : []),
    [showJump, jumpTargets, jumpQuery, state.targetDir],
  );
  const updateJumpQuery = (value: string) => {
    jumpQueryRef.current = value.slice(0, 512);
    jumpCursorRef.current = 0;
    setJumpQuery(jumpQueryRef.current);
    setJumpCursor(0);
    setJumpError(null);
  };
  const pickJump = (index: number) => {
    // Never act on a list painted for an older query.
    if (!folders || !openModalsRef.current.has("jump") || jumpQueryRef.current !== jumpQuery)
      return;
    const choice = jumpResults[index];
    if (!choice) return;
    const refusal = folders.go(choice.path);
    // On success this instance unmounts; on refusal the card stays and says why.
    if (refusal !== null) setJumpError(refusal);
  };

  const setMenu = (open: boolean) => {
    if (open) {
      if (!openModal("menu")) return;
      menuCursorRef.current = 0;
      menuQueryRef.current = "";
      setMenuQuery("");
      setMenuCursor(0);
    } else closeModal("menu");
    setShowMenuState(open);
  };

  const abortApply = useCallback(() => {
    // The runtime's raw-stdin deadman saw the same ETX byte and scheduled a
    // last-resort kill - the keymap owns this chord, so cancel it first.
    noteCtrlCHandled();
    applyAbortRef.current?.abort();
    setApplyProgress((progress) => (progress ? { ...progress, stage: "stopping" } : null));
  }, []);

  useEffect(() => {
    const unregister = registerUiApplyCancellation((closeAfterApply) => {
      if (!applyAbortRef.current) {
        if (!closeAfterApply) return false;
        finalize({ type: "abort" });
        return true;
      }
      closeAfterApplyRef.current ||= closeAfterApply;
      abortApply();
      return true;
    });
    return () => {
      unregister();
      applyAbortRef.current?.abort();
      applyAbortRef.current = null;
    };
  }, [abortApply, finalize]);

  const exportPlan = useCallback(() => {
    const s = readFreshState();
    if (s.scanning || s.scanIncomplete) {
      setNotice("scan incomplete: wait or press r to retry before saving");
      return;
    }
    if (getUiSummary(s).selectedCount === 0) {
      setNotice("nothing queued: space on a row queues it");
      return;
    }
    try {
      const file = writePlanExport(applyUiSelection(plan, s), process.cwd());
      setNotice(
        `plan saved: ${sanitizeTerminalText(basename(file))} (sweep apply --plan)`,
        "success",
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setNotice(`couldn't save plan: ${sanitizeTerminalText(reason)}`);
    }
  }, [plan, setNotice]);

  const yankPath = useCallback(() => {
    const s = readFreshState();
    const candidate = getCurrentCandidate(s);
    if (!candidate) {
      setNotice("nothing under the cursor");
      return;
    }
    const copied = renderer.copyToClipboardOSC52(candidate.path);
    setNotice(
      copied
        ? `copied ${sanitizeTerminalText(relativePath(s.targetDir, candidate.path))}`
        : "this terminal does not accept clipboard writes (OSC 52)",
      copied ? "success" : "warning",
    );
  }, [renderer, setNotice]);

  const applyVisual = useCallback(() => {
    // The reducer fn computes the transition on committed state - a queued
    // toggle in the same burst must be part of the range it applies. The
    // result is side-channelled out so the notice matches what committed.
    let result: ReturnType<typeof applyVisualRange> | undefined;
    flushSync(() => {
      dispatch({
        type: "mutate",
        fn: (s) => {
          const r = applyVisualRange(s);
          result = r;
          return r.state;
        },
      });
    });
    if (!result) return;
    const skipped = result.skipped > 0 ? `, skipped ${result.skipped} dangerous or blocked` : "";
    if (result.queued > 0) setNotice(`queued ${result.queued}${skipped}`, "success");
    else if (result.unqueued > 0) setNotice(`unqueued ${result.unqueued}${skipped}`, "neutral");
    else setNotice(`nothing queueable in that range${skipped}`);
  }, [setNotice]);

  const applyScopeToggle = useCallback(
    (scopeKey?: string | null) => {
      if (openModalsRef.current.size > 0) return;
      let result: ReturnType<typeof toggleSidebarScopeSelection> | undefined;
      flushSync(() => {
        dispatch({
          type: "mutate",
          fn: (s) => {
            const r =
              scopeKey === undefined
                ? toggleSidebarScopeSelection(s)
                : toggleScopeSelection(s, scopeKey);
            result = r;
            return r.state;
          },
        });
      });
      if (!result) return;
      const skipped = result.skipped > 0 ? `, skipped ${result.skipped} dangerous or blocked` : "";
      if (result.queued > 0) setNotice(`queued ${result.queued} in folder${skipped}`, "success");
      else if (result.unqueued > 0)
        setNotice(`unqueued ${result.unqueued} in folder${skipped}`, "neutral");
      else setNotice(`nothing queueable in that folder${skipped}`);
    },
    [setNotice],
  );

  /**
   * Enter on the pattern pane's add line. Validates through the same
   * assertSafePattern the config file loader uses - a pattern the file would
   * reject never enters state from the editor either.
   */
  const submitPatternDraft = useCallback(() => {
    flushSync();
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
      setNotice(`"${sanitizeTerminalText(draft)}" is in the catalog - space toggles it`, "neutral");
      return;
    }
    dispatch({
      type: "mutate",
      fn: (s) => addCustomPattern(setPatternInput(s, null), draft),
    });
    setNotice(`added "${sanitizeTerminalText(draft)}" - r rescans with it`, "success");
  }, [setNotice]);

  const closeConfigSave = () => {
    configSaveReadyRef.current = false;
    configSaveRef.current = null;
    closeModal("configSave");
    setConfigSave(null);
  };
  const confirmConfigSave = () => {
    const captured = configSaveRef.current;
    if (!captured || !configSaveReadyRef.current || !openModalsRef.current.has("configSave"))
      return;
    if (renderer.width < 40 || renderer.height < 12) return;
    closeConfigSave();
    try {
      writeProjectSweeprc(captured.path, captured.delta, true, captured.revision);
      setNotice("Saved patterns to .sweeprc · other settings kept", "success");
    } catch (error) {
      setNotice(
        `Patterns not saved · ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
      );
    }
  };
  const writeSweeprc = () => {
    if (openModalsRef.current.size > 0) return;
    const s = readFreshState();
    const path = join(s.targetDir, ".sweeprc");
    const delta = sweeprcPayload(s);
    try {
      const result = writeProjectSweeprc(path, delta);
      if (result === "exists") {
        const revision = projectSweeprcRevision(path);
        if (revision === null) {
          setNotice("Config changed; choose Save again to review it");
          return;
        }
        if (!openModal("configSave")) return;
        const captured = { path, delta: structuredClone(delta), revision };
        configSaveReadyRef.current = false;
        configSaveRef.current = captured;
        setConfigSave(captured);
      } else setNotice("Saved patterns to .sweeprc", "success");
    } catch (error) {
      setNotice(
        `Patterns not saved · ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
      );
    }
  };
  const inspectPattern = (pattern?: string) => {
    const selected = pattern ?? patternAtCursor(readFreshState());
    if (selected && openModal("patternInfo")) setPatternInfo(selected);
  };
  const closePatternInfo = () => {
    closeModal("patternInfo");
    setPatternInfo(null);
  };

  const closeFolderInfo = () => {
    closeModal("folderInfo");
    setFolderInfo(null);
  };
  const reviewInspected = () => {
    const id = inspectedIdRef.current;
    if (!id) return;
    setInspect(false);
    requestSingleApply(id);
  };

  const editingPatterns = state.focus === "patterns" || state.focus === "patternInput";
  const menuCommands = buildActionMenuCommands({
    state,
    summary,
    editingPatterns,
    idleSafeCount: idleSafe.length,
    idleSafeBytes,
    hasFolders: Boolean(folders),
    hasScan: Boolean(scan),
    motionEnabled,
    requestApply,
    setInspect,
    requestSingleApply,
    mutate,
    setNotice,
    focusPanel,
    setJump,
    openFolderInfo: () => {
      if (!openModal("folderInfo")) return;
      const fresh = readFreshState();
      const visible = getVisibleCandidates(fresh);
      setFolderInfo({
        path:
          fresh.scopeFilter === null || fresh.scopeFilter === ""
            ? fresh.targetDir
            : join(fresh.targetDir, fresh.scopeFilter),
        count: visible.length,
        queued: visible.filter((item) => fresh.selectedIds.has(item.id)).length,
        scanning: fresh.scanning,
      });
    },
    yankPath,
    exportPlan,
    writeSweeprc,
    inspectPattern,
    requestRescan,
    openPatternsView: () => {
      setView("folders");
      focusPanel("patterns");
    },
    toggleMotion: () => {
      motionEnabledRef.current = !motionEnabledRef.current;
      setMotionEnabled(motionEnabledRef.current);
    },
    setShowHelp,
    setFilterPicker,
  });

  const matchingCommands = (query: string) => {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return menuCommands.filter((command) => {
      const text = `${command.label} ${command.shortcut}`.toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
  };
  const filteredCommands = matchingCommands(menuQuery);
  const updateMenuQuery = (value: string) => {
    menuQueryRef.current = value.slice(0, 128);
    menuCursorRef.current = 0;
    setMenuQuery(menuQueryRef.current);
    setMenuCursor(0);
  };
  const runMenuCommand = (index: number) => {
    // A query change cannot activate a command from the preceding painted list.
    if (!showMenu || menuQueryRef.current !== menuQuery) return;
    const command = filteredCommands[index];
    if (!openModalsRef.current.has("menu") || !command || command.disabled) return;
    setMenu(false);
    command.run();
  };

  // Below 12 rows the projects list does not fit, so the folder view is what
  // is painted. Keys have to follow that paint, or arrows move a hidden cursor.
  const projectsVisible = view === "projects" && dimensions.height >= 12;

  const onKey = (key: KeyEvent) => {
    const preempted =
      openModalsRef.current.has("scanError") || openModalsRef.current.has("applying");
    if (
      !preempted &&
      (openModalsRef.current.has("configSave") || openModalsRef.current.has("patternInfo"))
    ) {
      key.preventDefault();
      const saving = openModalsRef.current.has("configSave");
      const close = saving ? closeConfigSave : closePatternInfo;
      if ((key.name === "c" && key.ctrl) || key.name === "ctrl+c") {
        noteCtrlCHandled();
        close();
        finalize({ type: "abort" });
      } else if (["escape", "q", "n"].includes(key.name)) close();
      else if (saving && key.name === "y" && !key.ctrl && !key.meta) confirmConfigSave();
      return;
    }
    if (!preempted && openModalsRef.current.has("folderInfo")) {
      key.preventDefault();
      if ((key.name === "c" && key.ctrl) || key.name === "ctrl+c") {
        noteCtrlCHandled();
        closeFolderInfo();
        finalize({ type: "abort" });
      } else if (["escape", "q"].includes(key.name)) closeFolderInfo();
      return;
    }
    if (!preempted && openModalsRef.current.has("filter")) {
      key.preventDefault();
      if ((key.name === "c" && key.ctrl) || key.name === "ctrl+c") {
        noteCtrlCHandled();
        setFilterPicker(false);
        finalize({ type: "abort" });
      } else if (["escape", "return", "enter", "f", "q"].includes(key.name)) {
        setFilterPicker(false);
      } else if (["up", "down", "k", "j", "tab"].includes(key.name)) {
        const count = filterOptions.length;
        if (count === 0) return;
        const delta =
          key.name === "up" || key.name === "k" || (key.name === "tab" && key.shift) ? -1 : 1;
        filterCursorRef.current = (filterCursorRef.current + delta + count) % count;
        setFilterCursor(filterCursorRef.current);
      } else if (key.name === "space") {
        toggleFilterOption(filterCursorRef.current);
      } else if (key.name === "c") {
        applyFilterEdit(clearFacets);
      }
      return;
    }
    if (!preempted && openModalsRef.current.has("jump")) {
      if ((key.name === "c" && key.ctrl) || key.name === "ctrl+c") {
        key.preventDefault();
        noteCtrlCHandled();
        setJump(false);
        finalize({ type: "abort" });
      } else if (key.name === "escape" || (key.ctrl && !key.meta && key.name === "o")) {
        key.preventDefault();
        setJump(false);
      } else if (["return", "enter"].includes(key.name)) {
        key.preventDefault();
        pickJump(jumpCursorRef.current);
      } else if (["up", "down", "tab"].includes(key.name)) {
        key.preventDefault();
        const count = jumpResults.length;
        if (count === 0) return;
        const delta = key.name === "up" || (key.name === "tab" && key.shift) ? -1 : 1;
        jumpCursorRef.current = (jumpCursorRef.current + delta + count) % count;
        setJumpCursor(jumpCursorRef.current);
      }
      return;
    }
    if (key.ctrl && !key.meta && key.name === "o" && folders && openModalsRef.current.size === 0) {
      key.preventDefault();
      setJump(true);
      return;
    }
    if (!preempted && openModalsRef.current.has("menu")) {
      if ((key.name === "c" && key.ctrl) || key.name === "ctrl+c") {
        key.preventDefault();
        noteCtrlCHandled();
        setMenu(false);
        finalize({ type: "abort" });
      } else if (
        ["escape", "f2"].includes(key.name) ||
        (key.ctrl && !key.meta && key.name === "k")
      ) {
        key.preventDefault();
        setMenu(false);
      } else if (["return", "enter"].includes(key.name)) {
        key.preventDefault();
        // Below this size the action list is not painted. Enter must not run
        // a row the user cannot see.
        if (dimensions.height >= 10 && dimensions.width >= 28)
          runMenuCommand(menuCursorRef.current);
      } else if (
        ["up", "down", "tab"].includes(key.name) &&
        dimensions.height >= 10 &&
        dimensions.width >= 28
      ) {
        key.preventDefault();
        const count = matchingCommands(menuQueryRef.current).length;
        if (count === 0) return;
        const delta = key.name === "up" || (key.name === "tab" && key.shift) ? -1 : 1;
        menuCursorRef.current = (menuCursorRef.current + delta + count) % count;
        setMenuCursor(menuCursorRef.current);
      }
      return;
    }
    if (
      (key.name === "f2" || (key.ctrl && !key.meta && key.name === "k")) &&
      openModalsRef.current.size === 0
    ) {
      key.preventDefault();
      setMenu(true);
      return;
    }
    // `b` moves between the calm projects view and the full folder review.
    if (
      key.name === "b" &&
      !key.ctrl &&
      !key.meta &&
      openModalsRef.current.size === 0 &&
      (state.focus === "list" || state.focus === "sidebar")
    ) {
      key.preventDefault();
      // The projects view has no sidebar: arriving with focus on the hidden
      // one would leave every key acting on a cursor nobody can see.
      if (viewRef.current === "folders" && state.focus === "sidebar") focusPanel("list");
      setView((current) => (current === "projects" ? "folders" : "projects"));
      return;
    }
    // Tab moves between panes in the full view. Here there is one pane, and
    // sending focus to the hidden sidebar made Space queue rows out of sight.
    if (
      projectsVisible &&
      key.name === "tab" &&
      openModalsRef.current.size === 0 &&
      (state.focus === "list" || state.focus === "sidebar")
    ) {
      key.preventDefault();
      if (state.focus === "sidebar") focusPanel("list");
      setNotice("one pane here · b opens the full view with folders", "warning");
      return;
    }
    if (projectsVisible && openModalsRef.current.size === 0 && state.focus === "list") {
      if (handleProjectKey(key)) {
        key.preventDefault();
        return;
      }
    }
    handleKeymap(
      {
        key,
        state,
        showHelp: openModalsRef.current.has("help"),
        pendingApply: openModalsRef.current.has("confirm"),
        showSidebar,
        scanError: openModalsRef.current.has("scanError") ? scanError : null,
        inspectOpen: openModalsRef.current.has("inspect"),
        pendingSingle: pendingSingleIdRef.current !== null,
        applying: applyAbortRef.current !== null,
        // Measured list rows once the pane has laid out; the height-minus-
        // chrome estimate only seeds the first frame before a size event.
        pageRows: viewportRowsRef.current ?? Math.max(6, dimensions.height - 10),
      },
      {
        finalize,
        mutate,
        commitMutation,
        focusPanel,
        setShowHelp,
        setPendingApply,
        requestApply,
        applyPlan,
        requestRescan,
        toggleEngine,
        toggleSort: () => mutate(toggleSortBy),
        openFilterPicker: () => setFilterPicker(true),
        dismissScanError: () => setScanError(null),
        setInspect,
        toggleTrash,
        toggleSizeLimitOverride,
        toggleMotion: () => {
          motionEnabledRef.current = !motionEnabledRef.current;
          setMotionEnabled(motionEnabledRef.current);
          setNotice(
            motionEnabledRef.current
              ? "Activity animation resumed"
              : "Activity animation paused · work continues",
            "neutral",
          );
        },
        exportPlan,
        yankPath,
        applyVisual,
        applyScopeToggle,
        writeSweeprc,
        inspectPattern: () => inspectPattern(),
        submitPatternDraft,
        requestSingleApply,
        requestInspectedApply: reviewInspected,
        confirmSingle,
        abortApply,
        notify: setNotice,
        readState: readFreshState,
        isConfirmArmed: () =>
          openModalsRef.current.has("confirm") &&
          confirmReadyRef.current &&
          renderer.width >= 40 &&
          renderer.height >= 12,
      },
    );
  };
  useKeyboard(onKey);
  // A click on a footer hint is that key, sent through the same handler.
  const pressKey = (input: KeyInput) => {
    let prevented = false;
    onKey({
      name: input.name ?? "",
      ctrl: input.ctrl === true,
      meta: input.meta === true,
      shift: input.shift === true,
      option: false,
      sequence: input.name && input.name.length === 1 ? input.name : "",
      number: false,
      raw: "",
      eventType: "press",
      source: "raw",
      get defaultPrevented() {
        return prevented;
      },
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    } as unknown as KeyEvent);
  };

  // Bracketed paste carrying an ETX byte is content, not ctrl+c - tell the
  // runtime's deadman the chord was handled so a paste can't kill the session.
  usePaste(() => noteCtrlCHandled());

  const inspectCandidate = useMemo(
    () =>
      showInspect
        ? state.candidates.find((candidate) => candidate.id === inspectedIdRef.current)
        : undefined,
    [showInspect, state],
  );

  // The inspected candidate can disappear mid-overlay (rescan, filter change):
  // without this the overlay unmounts while inspectOpen keeps trapping keys.
  useEffect(() => {
    if (showInspect && !inspectCandidate) setInspect(false);
  }, [showInspect, inspectCandidate]);

  // Arm only a committed dialog for the current scope; time alone is not consent.
  useEffect(() => {
    confirmReadyRef.current =
      pendingApply &&
      (pendingSingleId === null || state.candidates.some((c) => c.id === pendingSingleId));
  }, [pendingApply, pendingSingleId, state.candidates]);

  // The sidebar unmounts under a narrow terminal; focus must not survive
  // into a pane that no longer exists - the keymap does the same reconcile
  // for the pre-effect window.
  useEffect(() => {
    if (!showSidebar && state.focus === "sidebar") focusPanel("list");
  }, [showSidebar, state.focus, focusPanel]);

  const confirmPreview = useMemo(() => {
    if (!pendingApply || pendingSingleId || !reviewedApply) return [];
    // Only build a preview while it is visible. Dangerous paths lead, so a
    // small risky item is named even when three huge safe folders outrank it.
    return rankConfirmPreview(reviewedApply.candidates, reviewedApply.targetDir);
  }, [pendingApply, pendingSingleId, reviewedApply]);

  const engineChip =
    scanDurations[activeEngine] !== undefined
      ? `${activeEngine}·${formatScanMs(scanDurations[activeEngine]!)}`
      : activeEngine;

  const headerStats = buildHeaderStats(
    plan,
    summary,
    tokens,
    dryRun,
    dimensions.width,
    trashMode,
    // Compact chip: `rust·263ms` once timed; the full js-vs-rust verdict lives
    // in the completion notice, the header just needs the current backend.
    engineChip,
  );

  const headerStatsLean = buildHeaderStats(
    plan,
    summary,
    tokens,
    dryRun,
    dimensions.width,
    trashMode,
    engineChip,
    true,
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
  // The projects view is built from the same filtered list as the full view,
  // so a carried-over tier or scope narrows it too. Say so where the total is.
  const projectsNarrowing = [riskFilterLabel, scopeFilterLabel ? `in ${scopeFilterLabel}` : ""]
    .filter(Boolean)
    .join(" · ");

  // Overlays cover the panes but not the statusline, so the footer has to
  // describe whatever is actually on top or the user is left with no visible
  // way out of a modal.
  const visualActive = state.focus === "list" && visualRange(state) !== null;

  const pendingSingleCandidate =
    pendingSingleId === null || !candidatesById.has(pendingSingleId)
      ? undefined
      : reviewedApply?.candidates.find((c) => c.id === pendingSingleId);

  const footerContext: FooterContext =
    applying !== null
      ? { kind: "applying" }
      : scanError
        ? { kind: "scanError" }
        : pendingApply
          ? { kind: "confirm" }
          : configSave
            ? { kind: "configSave" }
            : patternInfo !== null || folderInfo !== null || showMenu || showFilter || showJump
              ? { kind: "help" }
              : showInspect
                ? { kind: "inspect" }
                : showHelp
                  ? { kind: "help" }
                  : visualActive
                    ? { kind: "visual" }
                    : { kind: "pane", focus: state.focus };

  const footerHints = footerHintItems(footerContext, {
    ...(dryRun ? { dryRun: true } : {}),
    ...(state.patternsDirty ? { patternsDirty: true } : {}),
    ...(summary.selectedCount > 0 && !state.scanning ? { queued: true } : {}),
    ...(dimensions.width < 72 ? { compact: true } : dimensions.width < 108 ? { medium: true } : {}),
  });
  const tallyContent = buildRiskTally(summary, tokens);
  const riskChipContent = riskFilterLabel
    ? t`  ${fg(tokens.warning)(`· risk: ${riskFilterLabel}`)}`
    : null;
  const scopeChipContent = scopeFilterLabel
    ? t`  ${fg(tokens.info)(`· scope: ${sanitizeTerminalText(scopeFilterLabel)}`)}`
    : null;
  const statusModeText = state.scanIncomplete
    ? " INCOMPLETE "
    : ` ${modeLabel(state.focus, false, visualActive)} `;
  // ScanModeChip: paddingX(2) + "SCANNING"(8) + gap(1) + 5-dot strip(9) = 20.
  // ModeChip: paddingX(4) + label.
  const statusModeWidth = state.scanning ? 20 : statusModeText.length + 4;
  const fittedStatus = fitStatusLine({
    totalWidth: Math.max(0, dimensions.width - 2),
    modeWidth: statusModeWidth,
    hints: footerHints,
    tallyWidth: dimensions.width >= 72 ? styledWidth(tallyContent) : 0,
    tallyPassive: summary.selectedCount === 0,
    ...(riskChipContent ? { riskChipWidth: styledWidth(riskChipContent) } : {}),
    ...(scopeChipContent ? { scopeChipWidth: styledWidth(scopeChipContent) } : {}),
  });
  const menuFits = dimensions.height >= 10 && dimensions.width >= 28;
  // Scan error and the delete overlay own the screen. Dialogs already open
  // stay in state (a pattern review comes back) but are not painted under them.
  const foregroundOverlay = applying !== null || scanError !== null;
  const menuHeight = Math.min(22, Math.max(1, dimensions.height - 2));
  const menuPageSize = Math.max(
    1,
    Math.min(
      Math.max(1, filteredCommands.length),
      menuHeight - 2 - (menuHeight < 12 ? 0 : 2) - 3 - 2,
    ),
  );
  const menuTop = Math.floor(menuCursor / menuPageSize) * menuPageSize;
  const moveMenuPage = (direction: -1 | 1) => {
    if (!openModalsRef.current.has("menu")) return;
    menuCursorRef.current = Math.max(
      0,
      Math.min(Math.max(0, filteredCommands.length - 1), menuTop + direction * menuPageSize),
    );
    setMenuCursor(menuCursorRef.current);
  };

  return (
    <MotionContext.Provider value={motionEnabled}>
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
        {projectsVisible ? (
          <ProjectsView
            tokens={tokens}
            width={dimensions.width}
            height={dimensions.height}
            target={displayTargetPath(state.targetDir)}
            rows={projectRows}
            cursor={projectCursor}
            now={Date.now()}
            scanning={state.scanning}
            sizedLabel={`scanning  ${state.scanSizedCount.toLocaleString()} of ${state.candidates.length.toLocaleString()} sized`}
            reclaimableBytes={projects.reduce((sum, project) => sum + project.queueableBytes, 0)}
            uniqueReclaimableBytes={(() => {
              const allQueueable = projects.flatMap((p) =>
                p.artifacts.filter((c) => c.riskTier === "safe" || c.riskTier === "caution"),
              );
              if (!allQueueable.some((c) => c.uniqueBytes !== undefined)) return undefined;
              const sum = allQueueable.reduce(
                (acc, c) => acc + (c.uniqueBytes ?? c.estimatedBytes),
                0,
              );
              const apparent = allQueueable.reduce((acc, c) => acc + c.estimatedBytes, 0);
              return Math.min(apparent, sum);
            })()}
            uniqueBytesPartial={state.uniqueBytesPartial}
            guardedBytes={projects.reduce((sum, project) => sum + project.guardedBytes, 0)}
            byCost={byCost}
            reclaimablePartial={projects.some((project) => project.reclaimablePartial)}
            guardedPartial={projects.some((project) => project.guardedPartial)}
            incomplete={state.scanIncomplete}
            projectCount={projects.length}
            idleBytes={idleSafeBytes}
            selectedBytes={summary.selectedBytes}
            uniqueSelectedBytes={(() => {
              const queued = state.candidates.filter((c) => state.selectedIds.has(c.id));
              if (!queued.some((c) => c.uniqueBytes !== undefined)) return undefined;
              const sum = queued.reduce((acc, c) => acc + (c.uniqueBytes ?? c.estimatedBytes), 0);
              return Math.min(summary.selectedBytes, sum);
            })()}
            selectedCount={summary.selectedCount}
            selectedIds={state.selectedIds}
            diskFree={disk?.free ?? null}
            receipt={receipt}
            {...(dryRun ? { dryRun: true } : {})}
            {...(trashMode ? { trash: true } : {})}
            failures={applyFailures}
            filter={state.filter}
            searchFocused={state.focus === "search"}
            {...(projectsNarrowing ? { narrowing: projectsNarrowing } : {})}
            {...(notice && (everQueued || notice.tone === "warning")
              ? { notice: t`${fg(noticeColor(notice.tone, tokens))(notice.text)}` }
              : !everQueued && !state.scanning && projects.length > 0
                ? {
                    // First steps, in plain words, until something is queued:
                    // the one thing a first look needs is how to start and
                    // that nothing goes without a confirm.
                    notice:
                      dimensions.width >= 110
                        ? t`${fg(tokens.textSecondary)("New here? ")}${fg(tokens.text)("space")}${fg(tokens.textMuted)(" picks a project, ")}${fg(tokens.text)("c")}${fg(tokens.textMuted)(" shows what would go. Nothing is deleted until you press ")}${fg(tokens.text)("y")}${fg(tokens.textMuted)(".")}`
                        : dimensions.width >= 56
                          ? t`${fg(tokens.text)("space")}${fg(tokens.textMuted)(" picks · ")}${fg(tokens.text)("c")}${fg(tokens.textMuted)(" reviews · nothing goes until ")}${fg(tokens.text)("y")}`
                          : // Narrower than this the sentence would be cut where its
                            // meaning flips, so say the one thing that matters.
                            t`${fg(tokens.text)("c")}${fg(tokens.textMuted)(" reviews · nothing goes until ")}${fg(tokens.text)("y")}`,
                  }
                : notice
                  ? { notice: t`${fg(noticeColor(notice.tone, tokens))(notice.text)}` }
                  : {})}
            footer={
              <KeyHints
                variant="caps"
                tokens={tokens}
                onPress={pressKey}
                hints={
                  // A dialog on top owns the keys, so the footer names its keys.
                  footerContext.kind === "pane"
                    ? calmHintItems({
                        scanning: state.scanning,
                        idleBytes: idleSafeBytes,
                        queued: summary.selectedCount > 0,
                        width: dimensions.width,
                      })
                    : footerHints
                }
              />
            }
            onFilterInput={(value) => mutate((s) => setFilter(s, value))}
            onFilterSubmit={() => focusPanel("list")}
            onCursorDelta={handleProjectCursorDelta}
            onRowPress={handleProjectRowPress}
          />
        ) : (
          <>
            {/* The ledger: how much can come back, and how much is chosen. */}
            {dimensions.height >= 12 ? (
              <LedgerBand
                tokens={tokens}
                width={dimensions.width}
                targetDir={state.targetDir}
                candidates={state.candidates}
                visible={visibleItems}
                selectedIds={state.selectedIds}
                summary={summary}
                riskFilter={state.riskFilter}
                scanning={state.scanning}
                incomplete={state.scanIncomplete}
                sizedCount={state.scanSizedCount}
                receipt={receipt}
                stats={headerStatsLean}
                onMenu={() => setMenu(true)}
                onQueueSafe={() => mutate(selectSafeOnly)}
                onReview={requestApply}
                onRiskFilter={(tier) => mutate((s) => setRiskFilter(s, tier))}
              />
            ) : (
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
            )}

            <box width="100%" flexGrow={1} minHeight={0} flexShrink={1}>
              <ReviewPane
                onOpenFilter={() => setFilterPicker(true)}
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
                onToggleSelection={(candidateId) =>
                  mutate((s) => toggleSelectionById(s, candidateId))
                }
                onToggleScopeQueue={applyScopeToggle}
                onSubmitPatternDraft={submitPatternDraft}
                onSavePatterns={writeSweeprc}
                onInspectPattern={inspectPattern}
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
                content={
                  notice
                    ? t`${fg(noticeColor(notice.tone, tokens))(notice.text)}`
                    : buildContextLine(state, tokens)
                }
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
                <ModeChip
                  label={` ${modeLabel(state.focus, false, visualActive)} `}
                  tokens={tokens}
                />
              )}
              <box
                flexGrow={1}
                minWidth={0}
                flexShrink={1}
                paddingLeft={1}
                flexDirection="row"
                overflow="hidden"
              >
                <KeyHints hints={fittedStatus.hints} tokens={tokens} onPress={pressKey} />
                {fittedStatus.showRiskChip && riskChipContent ? (
                  <text content={riskChipContent} wrapMode="none" />
                ) : null}
                {fittedStatus.showScopeChip && scopeChipContent ? (
                  <text content={scopeChipContent} wrapMode="none" />
                ) : null}
              </box>
              {fittedStatus.showTally ? (
                <box paddingLeft={2} paddingRight={1} flexShrink={0}>
                  <text content={tallyContent} wrapMode="none" />
                </box>
              ) : null}
            </box>
          </>
        )}

        {/*
        Overlay paint order mirrors keymap precedence so the overlay that owns
        input is always the one on top: inspect < help < confirm < scanError
        < applying. A scan error or a delete covers the dialog already open,
        so a click cannot land on the one underneath.
      */}
        {!foregroundOverlay && showInspect && inspectCandidate ? (
          <InspectOverlay
            tokens={tokens}
            candidate={inspectCandidate}
            queued={state.selectedIds.has(inspectCandidate.id)}
            targetDir={state.targetDir}
            onClose={() => setInspect(false)}
            onReview={reviewInspected}
          />
        ) : null}
        {!foregroundOverlay && showHelp ? (
          view === "projects" && projectsVisible ? (
            <ProjectsHelp tokens={tokens} width={dimensions.width} />
          ) : (
            <HelpOverlay tokens={tokens} width={dimensions.width} />
          )
        ) : null}
        {!foregroundOverlay && showFilter ? (
          <FilterPicker
            tokens={tokens}
            options={filterOptions}
            tallies={filterTallies}
            facets={readFacets(state.filter)}
            cursor={filterCursor}
            matched={{
              count: visibleItems.length,
              total: scopeCandidates.length,
              bytes: visibleItems.reduce((sum, item) => sum + item.estimatedBytes, 0),
            }}
            onToggle={toggleFilterOption}
            onClear={() => applyFilterEdit(clearFacets)}
            onClose={() => setFilterPicker(false)}
          />
        ) : null}
        {!foregroundOverlay && showJump ? (
          <FolderJump
            tokens={tokens}
            targetDir={state.targetDir}
            query={jumpQuery}
            results={jumpResults}
            cursor={jumpCursor}
            queuedCount={summary.selectedCount}
            error={jumpError}
            onInput={updateJumpQuery}
            onPick={pickJump}
          />
        ) : null}
        {!foregroundOverlay && folderInfo ? (
          <FolderInfoModal tokens={tokens} folderInfo={folderInfo} onClose={closeFolderInfo} />
        ) : null}
        {!foregroundOverlay && patternInfo !== null ? (
          <PatternInfoModal tokens={tokens} pattern={patternInfo} onClose={closePatternInfo} />
        ) : null}
        {!foregroundOverlay && configSave ? (
          <ConfigSaveModal
            tokens={tokens}
            configSave={configSave}
            canConfirm={dimensions.width >= 40 && dimensions.height >= 12}
            onConfirm={confirmConfigSave}
            onCancel={closeConfigSave}
          />
        ) : null}
        {!foregroundOverlay && showMenu ? (
          <ActionMenuModal
            tokens={tokens}
            query={menuQuery}
            fits={menuFits}
            cursor={menuCursor}
            top={menuTop}
            pageSize={menuPageSize}
            commands={filteredCommands}
            onInput={updateMenuQuery}
            onMovePage={moveMenuPage}
            onRunCommand={runMenuCommand}
            onClose={() => setMenu(false)}
          />
        ) : null}
        {!foregroundOverlay && pendingApply ? (
          pendingSingleId !== null && !pendingSingleCandidate ? (
            <UnavailableItemModal tokens={tokens} onClose={() => setPendingApply(false)} />
          ) : pendingSingleCandidate ? (
            <ConfirmOverlay
              tokens={tokens}
              disk={disk}
              selectedCount={1}
              directoryCount={
                pendingSingleCandidate.entryType === "directory" &&
                !pendingSingleCandidate.isSymlink
                  ? 1
                  : 0
              }
              linkOnly={pendingSingleCandidate.isSymlink}
              heading={`Only ${sanitizeTerminalText(relativePath(state.targetDir, pendingSingleCandidate.path))}`}
              otherQueuedCount={
                summary.selectedCount - Number(state.selectedIds.has(pendingSingleCandidate.id))
              }
              canConfirm={dimensions.width >= 40 && dimensions.height >= 12}
              feedback={
                dimensions.width < 40 || dimensions.height < 12
                  ? "Resize to 40 columns and 12 rows to review"
                  : notice?.text.startsWith("Press y")
                    ? notice.text
                    : undefined
              }
              applyPolicy={
                scan?.applyPolicy
                  ? {
                      ...scan.applyPolicy,
                      forceLarge: scan.applyPolicy.forceLarge || sizeLimitOverridden,
                    }
                  : undefined
              }
              sizeLimitOverridden={sizeLimitOverridden}
              onOverrideSizeLimit={
                scan?.applyPolicy &&
                scan.applyPolicy.maxSizeGB !== null &&
                !scan.applyPolicy.forceLarge &&
                !dryRun
                  ? toggleSizeLimitOverride
                  : undefined
              }
              lowerBound={pendingSingleCandidate.bytesKnown === false}
              selectedBytes={pendingSingleCandidate.estimatedBytes}
              dangerousCount={pendingSingleCandidate.riskTier === "dangerous" ? 1 : 0}
              previewPaths={[
                sanitizeTerminalText(relativePath(state.targetDir, pendingSingleCandidate.path)),
              ]}
              {...(dryRun ? { dryRun: true } : {})}
              {...(trashModeRef.current ? { trash: true } : {})}
              onConfirm={confirmReviewedApply}
              onCancel={() => setPendingApply(false)}
              onToggleTrash={() => {
                if (confirmReadyRef.current) toggleTrash();
              }}
            />
          ) : (
            <ConfirmOverlay
              tokens={tokens}
              disk={disk}
              selectedCount={reviewedApply?.selectedCandidateIds.length ?? 0}
              outsideViewCount={pendingScopeRef.current ? 0 : reviewedOutsideView}
              {...(pendingScopeRef.current
                ? {
                    heading: `Only ${pendingScopeRef.current.label}'s build output`,
                    otherQueuedCount: [...state.selectedIds].filter(
                      (id) => !pendingScopeRef.current!.ids.includes(id),
                    ).length,
                  }
                : {})}
              directoryCount={
                reviewedApply?.candidates.filter((c) => c.entryType === "directory" && !c.isSymlink)
                  .length ?? 0
              }
              canConfirm={dimensions.width >= 40 && dimensions.height >= 12}
              feedback={
                dimensions.width < 40 || dimensions.height < 12
                  ? "Resize to 40 columns and 12 rows to review"
                  : notice?.text.startsWith("Press y")
                    ? notice.text
                    : undefined
              }
              applyPolicy={
                scan?.applyPolicy
                  ? {
                      ...scan.applyPolicy,
                      forceLarge: scan.applyPolicy.forceLarge || sizeLimitOverridden,
                    }
                  : undefined
              }
              sizeLimitOverridden={sizeLimitOverridden}
              onOverrideSizeLimit={
                scan?.applyPolicy &&
                scan.applyPolicy.maxSizeGB !== null &&
                !scan.applyPolicy.forceLarge &&
                !dryRun
                  ? toggleSizeLimitOverride
                  : undefined
              }
              lowerBound={reviewedApply?.candidates.some((c) => c.bytesKnown === false) ?? false}
              selectedBytes={reviewedApply?.summary.estimatedTotalBytes ?? 0}
              dangerousCount={reviewedApply?.summary.riskCounts.dangerous ?? 0}
              previewPaths={confirmPreview}
              costLine={rebuildSummary(reviewedApply?.candidates ?? [], formatBytes)}
              {...(dryRun ? { dryRun: true } : {})}
              {...(trashModeRef.current ? { trash: true } : {})}
              onConfirm={confirmReviewedApply}
              onCancel={() => setPendingApply(false)}
              onToggleTrash={() => {
                if (confirmReadyRef.current) toggleTrash();
              }}
            />
          )
        ) : null}
        {scanError ? (
          <ScanErrorModal
            tokens={tokens}
            message={scanError}
            onRetry={() => {
              setScanError(null);
              requestRescan?.();
            }}
            onDismiss={() => setScanError(null)}
            onQuit={() => finalize({ type: "abort" })}
          />
        ) : null}
        {applying !== null ? (
          <ApplyOverlay
            tokens={tokens}
            name={applying}
            progress={applyProgress}
            targetDir={state.targetDir}
            trash={trashMode}
            onCancel={abortApply}
          />
        ) : null}
      </box>
    </MotionContext.Provider>
  );
}
