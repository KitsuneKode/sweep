import { bold, fg, type KeyEvent, StyledText, t } from "@opentui/core";
import {
  flushSync,
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import type { ApplyProgress, ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { statfsSync } from "node:fs";
import { basename, join } from "node:path";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { isColdRequested } from "@kitsunekode/sweep-core/cold";
import {
  writeProjectSweeprc,
  projectSweeprcRevision,
  type ProjectSweeprcDelta,
} from "@kitsunekode/sweep-core/config";
import { assertSafePattern, isApplyRefusedError } from "@kitsunekode/sweep-core/guardrails";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { ReviewPane } from "./ReviewPane.js";
import { candidateIndex } from "./candidate-index.js";
import { ApplyOverlay } from "./ApplyOverlay.js";
import { ActionButton } from "./ActionButton.js";
import { LedgerBand, type LedgerReceipt } from "./LedgerBand.js";
import { captureReviewedApply } from "./reviewed-apply.js";
import type { ViewPreferences } from "./view-preferences.js";
import { MotionContext, motionEnabledFromEnvironment } from "./motion.js";
import { handleKeymap, type KeyInput } from "./keymap.js";
import { KeyHints } from "./KeyHints.js";
import { darkTheme, mixHex } from "./theme.js";
import { Meter } from "./Meter.js";
import type { SweepUiOutcome } from "./outcome.js";
import { UiOperationSession } from "./operation-session.js";
import { writePlanExport } from "./plan-export.js";
import { noteCtrlCHandled, registerUiApplyCancellation } from "./runtime.js";
import {
  buildBrandLine,
  buildContextLine,
  footerHintItems,
  keycap,
  buildHeaderStats,
  buildRiskTally,
  modeLabel,
  relativePath,
  riskGlyph,
  type FooterContext,
  type FooterHint,
} from "./presentation.js";
import { cellWidth } from "./text-cells.js";
import { buildDisplayRows } from "./rows.js";
import {
  addCustomPattern,
  applyUiSelection,
  applyVisualRange,
  createUiState,
  finalizeScan,
  getCurrentCandidate,
  getUiSummary,
  mergeApplyReport,
  resetForRescan,
  rescanConfigFromState,
  setFocus,
  setPatternInput,
  setScanning,
  setScanCurrentDir,
  sweeprcPayload,
  patternAtCursor,
  toggleSelectionById,
  toggleSidebarScopeSelection,
  toggleScopeSelection,
  toggleSortBy,
  setScannedDirs,
  setSkippedDirs,
  upsertCandidates,
  clearSelection,
  clearVisibleSelection,
  selectVisible,
  setFilter,
  setRiskFilter,
  selectSafeOnly,
  selectIdleSafe,
  toggleIdsSelection,
  idleSafeCandidates,
  setScopeFilter,
  setThemeMode,
  visualRange,
  type SweepUiInitOptions,
  type SweepUiState,
} from "./state.js";
import { getVisibleCandidates } from "./state/selectors.js";
import {
  clearFacets,
  facetOptions,
  facetTallies,
  readFacets,
  toggleFacet,
} from "./filter-facets.js";
import { FilterPicker } from "./FilterPicker.js";
import {
  cycleThemeMode,
  noticeColor,
  resolveTheme,
  type NoticeTone,
  type ThemeTokens,
} from "./theme.js";
import { ModeChip, ScanModeChip, Modal } from "./widgets.js";
import type { FolderSwitcher, UiScanControl } from "./streaming.js";
import { FolderJump } from "./FolderJump.js";
import { ProjectsView } from "./ProjectsView.js";
import { useMonotonicFraction } from "./LedgerBand.js";
import {
  buildProjectRows,
  buildProjects,
  moveCursor as moveProjectCursor,
  settleCursor,
  type ProjectSection,
} from "./projects.js";
import { rankJumpTargets, type JumpTarget } from "./folder-jump.js";

export { runSweepUiStreaming } from "./streaming.js";
export type { SweepUiStreamingOptions } from "./streaming.js";

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
}

function styledContentFallback(message: string, closing: boolean): ReactNode {
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
      <text content={sanitizeTerminalText(message).slice(0, 4096)} fg={darkTheme.text} />
      <text content="" />
      <text
        content={
          closing
            ? "Closing the view; waiting for any active apply report."
            : "Press Ctrl+C to exit."
        }
        fg={darkTheme.textDim}
      />
    </box>
  );
}

export class UiErrorBoundary extends Component<
  { children: ReactNode; onError?: (error: Error) => void },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode; onError?: (error: Error) => void }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return styledContentFallback(this.state.error.message, this.props.onError !== undefined);
    }
    return this.props.children;
  }
}

/** A help row: keycap + what it does. Sections break on `keys === null`. */
type HelpRow = readonly [keys: string | null, description: string];

interface Notice {
  text: string;
  tone: NoticeTone;
}

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
  ["a · s", "queue visible · safe"],
  ["u / U", "clear entire queue / visible only"],
  ["x · d", "review this item’s removal"],
  ["c · ctrl+enter", "review queue (always confirms)"],
];

const HELP_VIEW: ReadonlyArray<HelpRow> = [
  [null, "view"],
  ["/", "filter list · tab cycles panes"],
  ["1 - 4", "risk filter"],
  ["f", "filter by risk · kind · size · age"],
  ["o", "sort size · name · age"],
  ["enter · i", "open item details"],
  ["ctrl-k / F2", "search actions and settings"],
  ["ctrl-o", "switch folder - fuzzy or a path"],
  ["b", "projects view ↔ full view"],
  ["i", "queue safe items in idle projects"],
  ["backspace", "up one folder in the tree"],
  ["y", "copy row path"],
  ["S", "save queue as a plan"],
];

const HELP_PATTERNS: ReadonlyArray<HelpRow> = [
  [null, "patterns (p)"],
  ["space", "toggle pattern"],
  ["/", "filter the catalog"],
  ["a · d", "add · remove custom"],
  ["w / W", "save patterns (review existing config)"],
  ["r", "rescan with new set"],
];

const HELP_APP: ReadonlyArray<HelpRow> = [
  [null, "app"],
  ["tab", "switch panes"],
  ["t", "theme dark · light · auto"],
  ["m", "pause / resume activity animation"],
  ["E", "swap scan engine js · rust"],
  ["q · ctrl-c", "quit · stop active cleanup"],
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
            {index > 0 ? <text content="" /> : null}
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
            content={t`${keycap(keys, tokens)}${" ".repeat(Math.max(1, keyWidth - cellWidth(keys)))}${fg(tokens.textSecondary)(description)}`}
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
  // Keycaps add a cell of fill on each side; +1 more keeps them off the text.
  const keyWidth =
    Math.max(
      ...HELP_LEFT.map(([k]) => (k === null ? 0 : cellWidth(k))),
      ...HELP_RIGHT.map(([k]) => (k === null ? 0 : cellWidth(k))),
    ) + 1;
  const leftWidth = keyWidth + 2 + Math.max(...HELP_LEFT.map(([, d]) => d.length));
  const rightWidth = keyWidth + 2 + Math.max(...HELP_RIGHT.map(([, d]) => d.length));
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

  // Hug the content: a card taller than its rows reads as unfinished.
  const lines = (rows: ReadonlyArray<HelpRow>) =>
    rows.reduce((n, [keys]) => n + (keys === null ? 2 : 1), 0) - 1; // first section has no gap
  const bodyLines = twoCol ? Math.max(lines(HELP_LEFT), lines(HELP_RIGHT)) : lines(HELP_SINGLE);
  const modalHeight = bodyLines + 3 + 4; // syntax + exit lines, border + padding

  return (
    <Modal tokens={tokens} title=" keys " width={modalWidth} height={modalHeight}>
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
        content={t`${fg(tokens.textDim)("esc unwinds one layer · ctrl-c stops cleanup, quits when idle")}`}
        wrapMode="none"
      />
    </Modal>
  );
}

export interface DiskSpace {
  free: number;
  total: number;
}

/**
 * The volume before and after, in one bar: the solid part stays used, the
 * soft part is what this removal gives back, the track is free already.
 * The confirm is the one moment the size is about to become real, so it is
 * shown against the whole disk rather than against the queue.
 */
function DiskAfter({
  tokens,
  disk,
  bytes,
  width,
  dryRun,
}: {
  tokens: ThemeTokens;
  disk: DiskSpace;
  bytes: number;
  width: number;
  dryRun?: boolean;
}) {
  const used = Math.max(0, disk.total - disk.free);
  const gain = Math.min(bytes, used);
  return (
    <>
      <text content="" />
      <text
        content={
          // A gain below the display's precision would read "37 GiB → 37 GiB".
          formatBytes(disk.free) === formatBytes(disk.free + gain)
            ? t`${fg(tokens.textMuted)("disk  ")}${fg(tokens.textSecondary)(`${formatBytes(disk.free)} free`)}${fg(tokens.textDim)("  ")}${bold(fg(tokens.positive)(`+${formatBytes(gain)}`))}${fg(tokens.textMuted)(dryRun ? " if removed" : " after")}`
            : t`${fg(tokens.textMuted)("disk  ")}${fg(tokens.textSecondary)(`${formatBytes(disk.free)} free`)}${fg(tokens.textDim)("  →  ")}${bold(fg(tokens.positive)(formatBytes(disk.free + gain)))}${fg(tokens.textMuted)(dryRun ? " if removed" : " after")}`
        }
        wrapMode="none"
      />
      <Meter
        width={width}
        value={(used - gain) / disk.total}
        preview={used / disk.total}
        fill={mixHex(tokens.meterTrack, tokens.textSecondary, 0.7)}
        previewColor={tokens.positive}
        track={tokens.meterTrack}
        background={tokens.surface}
      />
    </>
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
  applyPolicy,
  lowerBound,
  otherQueuedCount,
  linkOnly,
  feedback,
  onConfirm,
  onCancel,
  onToggleTrash,
  outsideViewCount = 0,
  directoryCount = 0,
  canConfirm = true,
  onOverrideSizeLimit,
  sizeLimitOverridden = false,
  disk,
}: {
  tokens: ThemeTokens;
  /** The volume the queue lives on, to draw what removal gives back. */
  disk?: DiskSpace | null | undefined;
  selectedCount: number;
  selectedBytes: number;
  dangerousCount: number;
  /** Largest queued candidates by bytes - the last gate should name names. */
  previewPaths: string[];
  applyPolicy?: { maxSizeGB: number | null; forceLarge: boolean } | undefined;
  lowerBound?: boolean;
  dryRun?: boolean;
  trash?: boolean;
  otherQueuedCount?: number;
  linkOnly?: boolean;
  feedback?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
  onToggleTrash: () => void;
  outsideViewCount?: number;
  directoryCount?: number;
  canConfirm?: boolean;
  onOverrideSizeLimit?: (() => void) | undefined;
  sizeLimitOverridden?: boolean;
}) {
  // Confirmation describes the operation, including link-only removal.
  const action = dryRun ? "Preview removal of" : trash ? "Move to trash" : "Permanently delete";
  const dangerous = dangerousCount > 0;
  const accent = dangerous && !trash ? tokens.danger : tokens.accent;
  const shown = previewPaths.slice(0, 3);
  const hidden = selectedCount - shown.length;
  // Trash on the same volume keeps the bytes, so only deletion draws a gain.
  const showDisk = disk !== null && disk !== undefined && disk.total > 0 && !trash;
  const { width: screenWidth } = useTerminalDimensions();
  const meterWidth = Math.max(8, Math.min(48, screenWidth - 12));

  return (
    <Modal
      tokens={tokens}
      title={`${dangerous ? "⚠ " : ""}${dryRun ? "Preview" : trash ? "Move" : "Delete"} ${selectedCount} item${selectedCount === 1 ? "" : "s"}${trash && !dryRun ? " to trash" : ""}`}
      titleColor={accent}
      width={56}
      height={
        (applyPolicy && applyPolicy.maxSizeGB !== null
          ? 24
          : selectedCount === 1 && !dangerous
            ? 18
            : 22) + (showDisk ? 3 : 0)
      }
      footer={
        <>
          {feedback ? <text fg={tokens.info} content={feedback} /> : null}
          <box flexDirection="row" flexWrap="wrap" gap={1}>
            <ActionButton
              tokens={tokens}
              label={dryRun ? "y Preview" : trash ? "y Move to trash" : "y Delete"}
              danger={!trash && !dryRun}
              disabled={!canConfirm}
              onPress={onConfirm}
            />
            <ActionButton tokens={tokens} label="n / Esc Cancel" onPress={onCancel} />
            {dryRun ? null : (
              <ActionButton
                tokens={tokens}
                label={trash ? "t Delete permanently instead" : "t Move to trash instead"}
                onPress={onToggleTrash}
              />
            )}
            {onOverrideSizeLimit ? (
              <ActionButton
                tokens={tokens}
                label={sizeLimitOverridden ? "f Restore size ceiling" : "f Override size ceiling"}
                onPress={onOverrideSizeLimit}
                disabled={!canConfirm}
              />
            ) : null}
          </box>
        </>
      }
    >
      <text
        fg={tokens.textMuted}
        content={otherQueuedCount === undefined ? "Apply the queued selection" : "Only this item"}
      />
      {outsideViewCount > 0 ? (
        <text
          fg={tokens.info}
          content={`${outsideViewCount} queued item${outsideViewCount === 1 ? " is" : "s are"} outside the current view.`}
        />
      ) : null}
      {directoryCount > 0 ? (
        <text content="Selected folders include everything inside them." fg={tokens.textMuted} />
      ) : null}
      <text
        content={t`${bold(fg(accent)(`${action} ${selectedCount} item${selectedCount === 1 ? "" : "s"}`))}`}
      />
      <text
        content={t`${fg(tokens.positive)(`${lowerBound ? "~" : ""}${formatBytes(selectedBytes)}`)} ${fg(tokens.textMuted)(lowerBound ? "partial estimate; actual bytes may differ" : "estimated size")}`}
      />
      {showDisk ? (
        <DiskAfter
          tokens={tokens}
          disk={disk}
          bytes={selectedBytes}
          width={meterWidth}
          {...(dryRun ? { dryRun: true } : {})}
        />
      ) : null}
      {shown.map((path) => (
        <text
          key={path}
          content={t`${fg(tokens.textDim)("·")} ${fg(tokens.textSecondary)(path)}`}
          wrapMode="word"
        />
      ))}
      {hidden > 0 ? (
        <text content={t`${fg(tokens.textDim)(`  …and ${hidden} more`)}`} wrapMode="none" />
      ) : null}
      {linkOnly ? (
        <text
          fg={tokens.warning}
          content={
            trash
              ? "Moves only the symbolic link. Linked contents stay."
              : "Removes only the symbolic link. Linked contents stay."
          }
        />
      ) : null}
      {otherQueuedCount !== undefined && otherQueuedCount > 0 ? (
        <text
          fg={tokens.textSecondary}
          content={`${otherQueuedCount} other queued item${otherQueuedCount === 1 ? " stays" : "s stay"} queued`}
        />
      ) : null}
      <text content="" />
      {applyPolicy && (applyPolicy.maxSizeGB !== null || applyPolicy.forceLarge) ? (
        <text
          fg={
            applyPolicy.forceLarge || applyPolicy.maxSizeGB !== null
              ? tokens.warning
              : tokens.textMuted
          }
          content={
            applyPolicy.forceLarge
              ? sizeLimitOverridden
                ? "Size ceiling overridden for this review only."
                : "Size ceiling bypass enabled (--force-large)."
              : applyPolicy.maxSizeGB === null
                ? "No byte ceiling"
                : `Size ceiling: ${applyPolicy.maxSizeGB} GiB; checked again before removal.`
          }
        />
      ) : null}
      {applyPolicy &&
      applyPolicy.maxSizeGB !== null &&
      !applyPolicy.forceLarge &&
      selectedBytes > applyPolicy.maxSizeGB * 1024 ** 3 ? (
        <box flexDirection="column">
          <text
            fg={tokens.warning}
            content="Over the limit. Reduce the queue or raise maxSizeGB in .sweeprc."
          />
          <text
            fg={tokens.warning}
            content={
              onOverrideSizeLimit
                ? "Choose Override size ceiling for this review, then confirm."
                : "Restart override: --force-large --yes"
            }
          />
        </box>
      ) : null}
      <text content="" />
      {dryRun ? (
        <text content={t`${fg(tokens.textDim)("Preview only. No files will be removed.")}`} />
      ) : dangerous ? (
        <text
          content={t`${fg(trash ? tokens.warning : tokens.danger)(
            trash
              ? `⚠ ${dangerousCount} dangerous item${dangerousCount === 1 ? "" : "s"} leave the working tree.`
              : `⚠ ${dangerousCount} dangerous item${dangerousCount === 1 ? "" : "s"} selected. This cannot be undone.`,
          )}`}
        />
      ) : trash ? (
        <text
          content={t`${fg(tokens.textDim)("Local trash; restore manually. Storage remains occupied.")}`}
        />
      ) : (
        <text
          content={t`${fg(tokens.textDim)("No items classified as dangerous. Permanent deletion has no undo.")}`}
        />
      )}
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
  onClose,
  onReview,
}: {
  tokens: ThemeTokens;
  candidate: ScanCandidate;
  queued: boolean;
  targetDir: string;
  onClose: () => void;
  onReview: () => void;
}) {
  const { width } = useTerminalDimensions();
  const compact = width < 48;
  const rel = relativePath(targetDir, candidate.path);
  const riskGlyphColor = {
    safe: tokens.positive,
    caution: tokens.warning,
    dangerous: tokens.danger,
    blocked: tokens.blocked,
  }[candidate.riskTier];

  const field = (label: string, value: string | StyledText) => (
    <box flexDirection={compact ? "column" : "row"} width="100%" flexShrink={0}>
      <text content={t`${fg(tokens.textDim)(label.padEnd(9))} `} wrapMode="none" />
      {typeof value === "string" ? (
        <text
          content={t`${fg(tokens.text)(value)}`}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          wrapMode="char"
        />
      ) : (
        <text content={value} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="char" />
      )}
    </box>
  );

  return (
    <Modal
      tokens={tokens}
      title=" artifact "
      width={64}
      height={22}
      footer={
        <box flexDirection="row" flexWrap="wrap" gap={1}>
          <ActionButton
            tokens={tokens}
            label="x Review removal"
            onPress={onReview}
            disabled={candidate.riskTier === "blocked"}
          />
          <ActionButton tokens={tokens} label="Esc Close" onPress={onClose} />
        </box>
      }
    >
      <box flexDirection="column">
        <text
          content={t`${fg(riskGlyphColor)(riskGlyph[candidate.riskTier])} ${bold(fg(tokens.text)(sanitizeTerminalText(candidate.name)))} ${fg(tokens.textMuted)(candidate.kind)}`}
          wrapMode="char"
        />
        <text content="" />
        {field("root", sanitizeTerminalText(targetDir))}
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
        <text
          content={
            candidate.isSymlink
              ? "Only the link is removed. Its destination stays."
              : candidate.kind === "node_modules"
                ? "Dependencies will need reinstalling. Check for local changes inside this folder."
                : candidate.kind === "target"
                  ? "Generated Cargo output can be rebuilt. The next build may take longer."
                  : "Check that you can recreate these contents before removing them."
          }
          fg={tokens.textSecondary}
          wrapMode="word"
        />
        {candidate.reasons.length > 0 ? (
          <>
            <text content="" />
            <text content={t`${fg(tokens.textDim)("why it was flagged:")}`} wrapMode="none" />
            {candidate.reasons.map((reason) => (
              <text
                key={reason}
                content={t`  ${fg(tokens.textDim)("·")} ${fg(tokens.textSecondary)(sanitizeTerminalText(reason))}`}
                wrapMode="char"
              />
            ))}
          </>
        ) : null}
        <text content="" />
      </box>
    </Modal>
  );
}

/** `~/x` for the calm header. */
function displayTargetPath(path: string): string {
  const home = process.env.HOME;
  if (home && path === home) return "~";
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

/** The calm view's one line of hints: only what applies right now. */
function calmHintItems(context: {
  scanning: boolean;
  idleBytes: number;
  queued: boolean;
  width: number;
}): FooterHint[] {
  const parts: FooterHint[] = [
    { key: "space", label: "queue", press: { name: "space" } },
    // With a queue, reviewing it is the next step: it never falls off the end.
    ...(context.queued ? [{ key: "c", label: "review", press: { name: "c" } }] : []),
    { key: "enter", label: "open", press: { name: "return" } },
  ];
  if (!context.scanning && context.idleBytes > 0)
    parts.push({
      key: "i",
      label: `queue idle ${formatBytes(context.idleBytes)}`,
      press: { name: "i" },
    });
  parts.push(
    { key: "/", label: "search", press: { name: "/" } },
    { key: "b", label: "full view", press: { name: "b" } },
    { key: "?", label: "keys", press: { name: "?" } },
  );
  let budget = context.width - 4;
  const kept: FooterHint[] = [];
  for (const part of parts) {
    const cost = part.key.length + part.label.length + 4;
    if (cost > budget) break;
    kept.push(part);
    budget -= cost;
  }
  return kept;
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
}: SweepAppProps) {
  const [state, dispatch] = useReducer(uiReducer, plan, (p: ScanPlan) =>
    createUiState(p, {
      ...(preferences ? { themeMode: preferences.themeMode, sortBy: preferences.sortBy } : {}),
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
  type ConfigSave = { path: string; delta: ProjectSweeprcDelta; revision: string };
  const [configSave, setConfigSave] = useState<ConfigSave | null>(null);
  const configSaveRef = useRef<ConfigSave | null>(null);
  const configSaveReadyRef = useRef(false);
  const [patternInfo, setPatternInfo] = useState<string | null>(null);
  useEffect(() => {
    configSaveReadyRef.current = configSave !== null;
  }, [configSave]);

  const [folderInfo, setFolderInfo] = useState<{
    path: string;
    count: number;
    queued: number;
    scanning: boolean;
  } | null>(null);
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
  type ModalKind =
    | "help"
    | "confirm"
    | "inspect"
    | "scanError"
    | "applying"
    | "menu"
    | "jump"
    | "filter"
    | "folderInfo"
    | "configSave"
    | "patternInfo";
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

  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [scanCommitToken, setScanCommitToken] = useState(0);
  const scanCommitSequence = useRef(0);
  const scanCommitWaiters = useRef(new Map<number, () => void>());
  useLayoutEffect(() => {
    for (const [token, release] of scanCommitWaiters.current) {
      if (token <= scanCommitToken) release();
    }
  }, [scanCommitToken]);
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
          pendingSingleIdRef.current === null ? fresh.selectedIds : [pendingSingleIdRef.current],
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
        setNotice(sanitizeTerminalText(error instanceof Error ? error.message : String(error)));
        return false;
      }
      setPendingApplyState(true);
      setNotice(null);
    } else {
      closeModal("confirm");
      setPendingApplyState(false);
      setPendingSingleId(null);
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
    else openModalsRef.current.add("scanError"); // preemptor - must trap input
    setScanErrorState(message);
  };
  const setApplying = (verb: string | null) => {
    if (verb === null) closeModal("applying");
    else openModalsRef.current.add("applying"); // preemptor
    setApplyingState(verb);
  };

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
    // Deliberately floating: a rejecting UiScanControl still becomes an
    // unhandled rejection - funnel it through the same path as onError.
    void Promise.resolve()
      .then(() => {
        if (gen !== generationRef.current || controller.signal.aborted) return;
        return scan.start(
          {
            waitForCommit: () => {
              if (gen !== generationRef.current || controller.signal.aborted)
                return Promise.resolve();
              const token = ++scanCommitSequence.current;
              const receipt = new Promise<void>((resolve) => {
                const release = () => {
                  scanCommitWaiters.current.delete(token);
                  controller.signal.removeEventListener("abort", release);
                  resolve();
                };
                scanCommitWaiters.current.set(token, release);
                controller.signal.addEventListener("abort", release, { once: true });
              });
              setScanCommitToken(token);
              return receipt;
            },
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
                  ? `scan complete: ${found.toLocaleString()} artifact${found === 1 ? "" : "s"} · ${scannedDirs.toLocaleString()} dirs`
                  : `scan complete: ${scannedDirs.toLocaleString()} dirs`;
              setNotice(
                `${base}${skippedDirs > 0 ? ` · ${skippedDirs} skipped (partial scan)` : ""} · ${engineTimingLabel(engineForRun, scanDurationsRef.current)}${isColdRequested() ? " · cold" : ""}`,
                skippedDirs > 0 ? "warning" : "success",
              );
              dispatch({
                type: "mutate",
                fn: (s) =>
                  finalizeScan(
                    setSkippedDirs(setScannedDirs(s, scannedDirs), skippedDirs),
                    finalPlan,
                  ),
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
      })
      .catch((error: unknown) => {
        if (gen !== generationRef.current || controller.signal.aborted) return;
        dispatch({ type: "mutate", fn: (s) => setScanning(s, false) });
        setScanError(error instanceof Error ? error.message : String(error));
      });
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
    // Flush queued mutations (pattern toggles in the same input burst) so the
    // rescan actually scans what the user just toggled - otherwise r applies
    // the pre-burst pattern set while the UI already shows the new one.
    const { disabledPatterns, extraPatterns } = rescanConfigFromState(readFreshState());
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
    const { disabledPatterns, extraPatterns } = rescanConfigFromState(readFreshState());
    scan.syncPatterns(disabledPatterns, extraPatterns);
    dispatch({ type: "mutate", fn: resetForRescan });
    startScan();
  }, [scan, activeEngine, startScan]);

  // The terminal's own background, asked once: the canvas adopts it (colour,
  // opacity) and every tint is mixed from it. Unanswered, the brand canvas stays.
  const paletteRenderer = useRenderer();
  const [terminalBackground, setTerminalBackground] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    try {
      paletteRenderer
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
  }, [paletteRenderer]);
  const tokens = useMemo(
    () => resolveTheme(state.themeMode, terminalBackground),
    [state.themeMode, terminalBackground],
  );
  const summary = useMemo(() => getUiSummary(state), [state]);
  // A receipt describes the last removal; queueing again starts a new story.
  useEffect(() => {
    if (summary.selectedCount > 0) setReceipt(null);
  }, [summary.selectedCount > 0]);
  const dimensions = useTerminalDimensions();
  const sidebarWidth =
    dimensions.width >= 140 ? 48 : dimensions.width >= 110 ? 38 : dimensions.width >= 90 ? 32 : 26;
  const showSidebar = dimensions.width >= 72;

  const mutate = useCallback((fn: (s: SweepUiState) => SweepUiState) => {
    // Every user-input mutation funnels here: keymap actions AND mouse paths
    // (row clicks, wheel, scrollbar drag via onSeek). While an overlay is
    // live, input belongs to it - a captured scrollbar drag surviving a
    // modal open would otherwise keep moving a cursor nobody can see, and
    // the next destructive key would land on the wrong row. Async dispatches
    // (scan batches, apply merges) use `dispatch` directly and stay ungated.
    if (openModalsRef.current.size > 0) return;
    setNotice(null);
    dispatch({ type: "mutate", fn });
  }, []);

  const visibleItems = useMemo(() => getVisibleCandidates(state), [state]);

  // ── The projects view: one row per project, grouped by idle time ──────
  const [view, setView] = useState(initialView);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => new Set());
  const [openSections, setOpenSections] = useState<ReadonlySet<ProjectSection>>(() => new Set());
  const [allArtifacts, setAllArtifacts] = useState<ReadonlySet<string>>(() => new Set());
  const [projectCursorState, setProjectCursorState] = useState(0);
  const projects = useMemo(
    () => buildProjects(visibleItems, state.selectedIds, state.targetDir),
    [visibleItems, state.selectedIds, state.targetDir],
  );
  const projectRows = useMemo(
    () => buildProjectRows(projects, expandedProjects, openSections, allArtifacts),
    [projects, expandedProjects, openSections, allArtifacts],
  );
  const projectCursor = settleCursor(projectRows, projectCursorState);
  // Keys in one stdin burst (j j Enter) must each see the previous key's
  // effect: the handler reads these refs, not this render's values.
  const projectRowsRef = useRef(projectRows);
  projectRowsRef.current = projectRows;
  const projectCursorRef = useRef(projectCursor);
  projectCursorRef.current = projectCursor;
  const expandedRef = useRef(expandedProjects);
  expandedRef.current = expandedProjects;
  const setProjectCursor = (index: number) => {
    projectCursorRef.current = index;
    setProjectCursorState(index);
  };
  const sizedFraction = useMonotonicFraction(
    state.candidates.length > 0 ? state.scanSizedCount / state.candidates.length : 0,
    state.scanning,
  );
  const disk = useMemo((): DiskSpace | null => {
    try {
      const stats = statfsSync(state.targetDir);
      return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
    } catch {
      return null;
    }
    // Re-read after a scan or an apply, not on every keystroke.
  }, [state.targetDir, state.scanning, receipt]);

  /**
   * Keys the projects view owns. Everything else (search, help, actions,
   * review, quit) falls through to the shared keymap. Keys that act on the
   * folder view's hidden cursor (x, d, y, v, p) are answered, not passed on.
   */
  const handleProjectKey = (key: {
    name: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
  }) => {
    if (key.ctrl || key.meta) {
      if (key.name === "d" || key.name === "u") {
        const page = Math.max(1, dimensions.height - 10) * (key.name === "d" ? 1 : -1);
        setProjectCursor(moveProjectCursor(projectRowsRef.current, projectCursorRef.current, page));
        return true;
      }
      return false;
    }
    const rows = projectRowsRef.current;
    const row = rows[projectCursorRef.current];
    const move = (delta: number) => {
      setProjectCursor(moveProjectCursor(projectRowsRef.current, projectCursorRef.current, delta));
      return true;
    };
    const openSection = (section: ProjectSection) => {
      const next = new Set(openSections);
      next.add(section);
      projectRowsRef.current = buildProjectRows(projects, expandedRef.current, next, allArtifacts);
      setOpenSections(next);
      return true;
    };
    const showAllArtifacts = (projectKey: string) => {
      const next = new Set(allArtifacts);
      next.add(projectKey);
      projectRowsRef.current = buildProjectRows(projects, expandedRef.current, openSections, next);
      setAllArtifacts(next);
      return true;
    };
    const setOpen = (keyName: string, open: boolean) => {
      const next = new Set(expandedRef.current);
      if (open) next.add(keyName);
      else next.delete(keyName);
      expandedRef.current = next;
      // Rows change shape now, so the next key in this burst sees them.
      projectRowsRef.current = buildProjectRows(projects, next, openSections, allArtifacts);
      setExpandedProjects(next);
    };
    switch (key.name) {
      case "up":
      case "k":
        return move(-1);
      case "down":
      case "j":
        return move(1);
      case "pageup":
        return move(-Math.max(1, dimensions.height - 10));
      case "pagedown":
        return move(Math.max(1, dimensions.height - 10));
      case "home":
        return move(-Number.MAX_SAFE_INTEGER);
      case "end":
        return move(Number.MAX_SAFE_INTEGER);
      case "g":
        return move(key.shift ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER);
      case "G":
        return move(Number.MAX_SAFE_INTEGER);
      case "space":
        if (row?.kind === "more") return openSection(row.section);
        if (row?.kind === "moreArtifacts") return showAllArtifacts(row.project.key);
        if (row?.kind === "project") mutate((s) => toggleIdsSelection(s, row.project.queueable));
        else if (row?.kind === "artifact") {
          if (row.candidate.riskTier === "blocked")
            setNotice("blocked: git-tracked or a project file, never removable");
          else mutate((s) => toggleSelectionById(s, row.candidate.id));
        }
        return true;
      case "return":
      case "enter":
      case "right":
      case "l":
        if (row?.kind === "more") return openSection(row.section);
        if (row?.kind === "moreArtifacts") return showAllArtifacts(row.project.key);
        if (row?.kind === "project")
          setOpen(
            row.project.key,
            !(key.name === "return" || key.name === "enter") ||
              !expandedProjects.has(row.project.key),
          );
        else if (row?.kind === "artifact" && (key.name === "return" || key.name === "enter"))
          setInspect(true, row.candidate.id);
        return true;
      case "left":
      case "h":
        if (row?.kind === "artifact" || row?.kind === "moreArtifacts") {
          const parent = rows.findIndex(
            (candidate) =>
              candidate.kind === "project" && candidate.project.key === row.project.key,
          );
          setOpen(row.project.key, false);
          if (parent >= 0) setProjectCursor(parent);
        } else if (row?.kind === "project") setOpen(row.project.key, false);
        return true;
      case "i":
        if (state.scanning) {
          setNotice("idle times arrive when the scan finishes");
          return true;
        }
        if (idleSafe.length === 0) {
          setNotice("no safe items in projects idle 30+ days");
          return true;
        }
        mutate(selectIdleSafe);
        setNotice(
          `queued ${idleSafe.length.toLocaleString()} items in idle projects · ${formatBytes(idleSafeBytes)}`,
          "success",
        );
        return true;
      case "x":
      case "d":
      case "y":
      case "v":
      case "p":
        setNotice(
          "press b for the full view: removal by item, copy, ranges and patterns live there",
        );
        return true;
      default:
        return false;
    }
  };
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
      abortRef.current?.abort();
      onDone(operations.outcome(outcome));
    },
    [onDone, operations],
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
  const commitMutation = useCallback((fn: (s: SweepUiState) => SweepUiState) => {
    if (openModalsRef.current.size > 0) return;
    flushSync(() => {
      setNotice(null);
      dispatch({ type: "mutate", fn });
    });
  }, []);

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

  const runInSessionApply = useCallback(
    (scopedPlan: ScanPlan, name: string) => {
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
          setReceipt({
            removed: merged.removedIds.length,
            failed: merged.failed,
            unattempted: merged.unattempted,
            freedBytes: merged.freedBytes,
            trash: Boolean(result.trashDir),
            stopped,
          });
          const verb = result.trashDir ? "moved to trash" : "deleted";
          const reviewedPath =
            scopedPlan.selectedCandidateIds.length === 1 ? ` · path: ${name}` : "";
          const clean = !stopped && merged.failed === 0;
          // The calm view says a clean result in its answer line; the notice
          // stays for anything that went wrong, and in the full view.
          if (!clean || viewRef.current !== "projects")
            setNotice(
              `${stopped ? "stopped · " : ""}${merged.removedIds.length} ${verb} · ${getUiSummary(merged.state).selectedCount} still queued · ${merged.failed} failed · ${merged.unattempted} unattempted · ~${formatBytes(merged.freedBytes)} estimated bytes ${result.trashDir ? "moved" : "removed"}${reviewedPath}${merged.firstFailure ? ` · ${sanitizeTerminalText(merged.firstFailure)}` : ""}`,
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
    [scan, finalize, dryRun, operations],
  );

  const applyPlan = useCallback(() => {
    const fresh = readFreshState();
    if (fresh.scanning || fresh.scanIncomplete) return;
    const selectedPlan = reviewedApplyRef.current;
    if (!selectedPlan || pendingSingleIdRef.current !== null) return;
    if (selectedPlan.selectedCandidateIds.length === 0) return;
    runInSessionApply(selectedPlan, `${selectedPlan.selectedCandidateIds.length} queued artifacts`);
  }, [runInSessionApply]);

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
    runInSessionApply(singlePlan, name);
  }, [runInSessionApply]);

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

  const renderer = useRenderer();

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
  }, [plan]);

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
  }, [renderer]);

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
  }, []);

  const applyScopeToggle = useCallback((scopeKey?: string | null) => {
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
  }, []);

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
  }, []);

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
  const idleSafe = useMemo(
    () => idleSafeCandidates({ candidates: state.candidates }),
    [state.candidates],
  );
  const idleSafeBytes = idleSafe.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0);
  const menuCommands = [
    {
      label: `Review queue (${summary.selectedCount})`,
      shortcut: "c",
      run: requestApply,
      disabled: state.scanning || state.scanIncomplete || summary.selectedCount === 0,
    },
    {
      label: "Inspect current item",
      shortcut: "i",
      run: () => setInspect(true),
      disabled: editingPatterns || !getCurrentCandidate(state),
    },
    {
      label: "Review removal of current item",
      shortcut: "x",
      run: () => requestSingleApply(),
      disabled:
        state.scanning ||
        state.scanIncomplete ||
        editingPatterns ||
        !getCurrentCandidate(state) ||
        getCurrentCandidate(state)?.riskTier === "blocked",
    },
    {
      // The recommendation: what nobody is using, across the whole target.
      label:
        idleSafe.length > 0
          ? `Queue safe items in projects idle 30+ days (${idleSafe.length.toLocaleString()} · ${formatBytes(idleSafeBytes)})`
          : "Queue safe items in projects idle 30+ days",
      shortcut: "",
      run: () => {
        mutate(selectIdleSafe);
        setNotice(
          `queued ${idleSafe.length.toLocaleString()} items in idle projects · ${formatBytes(idleSafeBytes)}`,
          "success",
        );
      },
      disabled: editingPatterns || state.scanning || idleSafe.length === 0,
    },
    {
      label: "Queue safe items in this view",
      shortcut: "s",
      run: () => mutate(selectSafeOnly),
      disabled: editingPatterns,
    },
    {
      label: "Clear whole queue",
      shortcut: "u",
      run: () => mutate(clearSelection),
      disabled: summary.selectedCount === 0,
    },
    {
      label: "Clear queue in this view",
      shortcut: "Shift+U",
      run: () => mutate(clearVisibleSelection),
      disabled: editingPatterns || summary.visibleSelectedCount === 0,
    },
    {
      label: "Queue safe and caution items in this view",
      shortcut: "a",
      run: () => mutate((s) => selectVisible(s, false)),
      disabled: editingPatterns,
    },
    { label: "Filter items", shortcut: "/", run: () => focusPanel("search"), disabled: false },
    {
      label: "Clear search and risk filters",
      shortcut: "",
      run: () => mutate((s) => setFilter(setRiskFilter(s, "all"), "")),
      disabled: false,
    },
    {
      label: "Switch to another folder…",
      shortcut: "ctrl+o",
      run: () => setJump(true),
      disabled: !folders,
    },
    {
      label: "Browse all folders",
      shortcut: "",
      run: () => mutate((s) => setScopeFilter(s, null)),
      disabled: false,
    },
    {
      label: "Current folder details",
      shortcut: "",
      run: () => {
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
      disabled: false,
    },
    {
      label: "Copy current item path",
      shortcut: "y",
      run: yankPath,
      disabled: editingPatterns || !getCurrentCandidate(state),
    },
    {
      label: "Save queue as a plan",
      shortcut: "Shift+S",
      run: exportPlan,
      disabled: state.scanning || state.scanIncomplete || summary.selectedCount === 0,
    },
    {
      label: "Save cleanup patterns",
      shortcut: "w",
      run: writeSweeprc,
      disabled:
        !editingPatterns || (state.focus === "patternInput" && state.patternInputMode === "add"),
    },
    {
      label: "Inspect current pattern",
      shortcut: "i",
      run: () => inspectPattern(),
      disabled: !editingPatterns || !patternAtCursor(state),
    },
    { label: "Scan again", shortcut: "r", run: requestRescan, disabled: !scan },
    {
      label: "Edit cleanup patterns",
      shortcut: "p",
      run: () => focusPanel("patterns"),
      disabled: false,
    },
    {
      label: `Sort by ${state.sortBy === "size" ? "name" : state.sortBy === "name" ? "oldest first" : "largest first"}`,
      shortcut: "o",
      run: () => mutate(toggleSortBy),
      disabled: false,
    },
    {
      label: `Use ${cycleThemeMode(state.themeMode)} theme`,
      shortcut: "t",
      run: () => mutate((s) => setThemeMode(s, cycleThemeMode(s.themeMode))),
      disabled: false,
    },
    {
      label: `Activity animation: ${motionEnabled ? "on" : "paused"}`,
      shortcut: "m",
      run: () => {
        motionEnabledRef.current = !motionEnabledRef.current;
        setMotionEnabled(motionEnabledRef.current);
      },
      disabled: false,
    },
    { label: "Help and shortcuts", shortcut: "?", run: () => setShowHelp(true), disabled: false },
    {
      label: "Filter by risk, kind, size or age",
      shortcut: "f",
      run: () => setFilterPicker(true),
      disabled: false,
    },
  ];
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
      } else if (
        ["return", "enter"].includes(key.name) &&
        dimensions.height >= 10 &&
        dimensions.width >= 28
      ) {
        key.preventDefault();
        runMenuCommand(menuCursorRef.current);
      } else if (["up", "down", "tab"].includes(key.name)) {
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
      setView((current) => (current === "projects" ? "folders" : "projects"));
      return;
    }
    if (view === "projects" && openModalsRef.current.size === 0 && state.focus === "list") {
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
    if (!pendingApply || pendingSingleId) return [];
    // Only build a preview while it is visible. Keep three entries instead
    // of sorting the entire queue on every stream batch or keypress.
    const priority = { dangerous: 3, caution: 2, safe: 1, blocked: 0 };
    const top: ScanCandidate[] = [];
    for (const candidate of reviewedApply?.candidates ?? []) {
      if (candidate.riskTier === "blocked") continue;
      const index = top.findIndex(
        (other) =>
          priority[candidate.riskTier] > priority[other.riskTier] ||
          (priority[candidate.riskTier] === priority[other.riskTier] &&
            candidate.estimatedBytes > other.estimatedBytes),
      );
      top.splice(index < 0 ? top.length : index, 0, candidate);
      if (top.length > 3) top.pop();
    }
    return top.map(
      (candidate) =>
        `${candidate.riskTier}${candidate.isSymlink ? " · link only" : ""} · ${candidate.bytesKnown === false ? "~" : ""}${formatBytes(candidate.estimatedBytes)} · ${sanitizeTerminalText(relativePath(reviewedApply!.targetDir, candidate.path))}`,
    );
  }, [pendingApply, pendingSingleId, reviewedApply]);

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

  const headerStatsLean = buildHeaderStats(
    plan,
    summary,
    tokens,
    dryRun,
    dimensions.width,
    trashMode,
    scanDurations[activeEngine] !== undefined
      ? `${activeEngine}·${formatScanMs(scanDurations[activeEngine]!)}`
      : activeEngine,
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
  // Below this width the tally and the risk/sort chips crowd the key hints out
  // of the statusline entirely; the hints are the part that must survive.
  const roomForTally = dimensions.width >= 84;
  const roomForChips = dimensions.width >= 100;
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
        {view === "projects" && dimensions.height >= 12 ? (
          <ProjectsView
            tokens={tokens}
            width={dimensions.width}
            height={dimensions.height}
            target={displayTargetPath(state.targetDir)}
            rows={projectRows}
            cursor={projectCursor}
            now={Date.now()}
            scanning={state.scanning}
            sizedFraction={sizedFraction}
            sizedLabel={`scanning  ${state.scanSizedCount.toLocaleString()} of ${state.candidates.length.toLocaleString()} sized`}
            reclaimableBytes={projects.reduce((sum, project) => sum + project.queueableBytes, 0)}
            projectCount={projects.length}
            idleBytes={idleSafeBytes}
            selectedBytes={summary.selectedBytes}
            selectedCount={summary.selectedCount}
            selectedIds={state.selectedIds}
            diskFree={disk?.free ?? null}
            receipt={receipt}
            {...(dryRun ? { dryRun: true } : {})}
            {...(trash ? { trash: true } : {})}
            filter={state.filter}
            searchFocused={state.focus === "search"}
            {...(notice ? { notice: t`${fg(noticeColor(notice.tone, tokens))(notice.text)}` } : {})}
            footer={
              <KeyHints
                variant="plain"
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
            onCursorDelta={(delta) =>
              setProjectCursor(
                moveProjectCursor(projectRowsRef.current, projectCursorRef.current, delta),
              )
            }
            onRowPress={(index, onMark) => {
              const row = projectRows[index];
              setProjectCursor(index);
              if (!row || row.kind === "section" || row.kind === "spacer") return;
              if (row.kind === "more") {
                setOpenSections((current) => new Set([...current, row.section]));
                return;
              }
              if (row.kind === "moreArtifacts") {
                setAllArtifacts((current) => new Set([...current, row.project.key]));
                return;
              }
              if (onMark) {
                if (row.kind === "project")
                  mutate((s) => toggleIdsSelection(s, row.project.queueable));
                else mutate((s) => toggleSelectionById(s, row.candidate.id));
              } else if (row.kind === "project") {
                setExpandedProjects((current) => {
                  const next = new Set(current);
                  if (next.has(row.project.key)) next.delete(row.project.key);
                  else next.add(row.project.key);
                  return next;
                });
              }
            }}
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
              <box flexGrow={1} minWidth={0} flexShrink={1} paddingLeft={1} flexDirection="row">
                <KeyHints hints={footerHints} tokens={tokens} onPress={pressKey} />
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
              </box>
              {roomForTally ? (
                <box paddingLeft={2} paddingRight={1} flexShrink={1}>
                  <text content={tallyContent} wrapMode="none" />
                </box>
              ) : null}
            </box>
          </>
        )}

        {/*
        Overlay paint order mirrors keymap precedence so the overlay that owns
        input is always the one on top: inspect < help < confirm < scanError
        < applying. Stale flags can coexist for one drain (a modal opened in
        the same burst as a scan error), and painting the higher-precedence
        overlay last keeps "what you see" == "what owns the keys".
      */}
        {showInspect && inspectCandidate ? (
          <InspectOverlay
            tokens={tokens}
            candidate={inspectCandidate}
            queued={state.selectedIds.has(inspectCandidate.id)}
            targetDir={state.targetDir}
            onClose={() => setInspect(false)}
            onReview={reviewInspected}
          />
        ) : null}
        {showHelp ? <HelpOverlay tokens={tokens} width={dimensions.width} /> : null}
        {showFilter ? (
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
        {showJump ? (
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
        {folderInfo ? (
          <Modal
            tokens={tokens}
            title=" Current folder "
            width={64}
            height={14}
            footer={<ActionButton tokens={tokens} label="Esc Close" onPress={closeFolderInfo} />}
          >
            <text
              content={sanitizeTerminalText(folderInfo.path)}
              wrapMode="char"
              fg={tokens.text}
            />
            <text
              content={`${folderInfo.count} items in this view · ${folderInfo.queued} queued here`}
              fg={tokens.textSecondary}
              wrapMode="word"
            />
            <text
              content="Folder, search and risk filters determine this view. Browsing does not change your queue."
              fg={tokens.textMuted}
              wrapMode="word"
            />
            {folderInfo.scanning ? (
              <text
                content="Scan is running; these are a snapshot of discovered items."
                fg={tokens.warning}
                wrapMode="word"
              />
            ) : null}
          </Modal>
        ) : null}
        {patternInfo !== null ? (
          <Modal
            tokens={tokens}
            title=" Pattern details "
            width={60}
            footer={<ActionButton tokens={tokens} label="Esc Close" onPress={closePatternInfo} />}
          >
            <text content={sanitizeTerminalText(patternInfo)} fg={tokens.text} wrapMode="word" />
            <text
              content="Matches artifact names inside the scanned tree."
              fg={tokens.textMuted}
              wrapMode="word"
            />
          </Modal>
        ) : null}
        {configSave ? (
          <Modal
            tokens={tokens}
            title=" Save cleanup patterns? "
            width={60}
            height={20}
            footer={
              <box flexDirection="row" flexWrap="wrap" gap={1}>
                <ActionButton
                  tokens={tokens}
                  label="y Save patterns"
                  disabled={dimensions.width < 40 || dimensions.height < 12}
                  onPress={confirmConfigSave}
                />
                <ActionButton tokens={tokens} label="n / Esc Cancel" onPress={closeConfigSave} />
              </box>
            }
          >
            <text
              content={sanitizeTerminalText(configSave.path)}
              fg={tokens.text}
              wrapMode="word"
            />
            <text
              content="Updates patterns and disabledPatterns only. Other settings are kept."
              fg={tokens.textMuted}
              wrapMode="word"
            />
            <text content="Extra patterns:" fg={tokens.text} />
            {configSave.delta.patterns.length ? (
              configSave.delta.patterns.map((pattern) => (
                <text
                  key={`on-${pattern}`}
                  content={sanitizeTerminalText(pattern)}
                  fg={tokens.textSecondary}
                  wrapMode="word"
                />
              ))
            ) : (
              <text content="None; built-in defaults remain." fg={tokens.textSecondary} />
            )}
            <text content="Disabled defaults:" fg={tokens.text} />
            {configSave.delta.disabledPatterns.length ? (
              configSave.delta.disabledPatterns.map((pattern) => (
                <text
                  key={`off-${pattern}`}
                  content={sanitizeTerminalText(pattern)}
                  fg={tokens.textSecondary}
                  wrapMode="word"
                />
              ))
            ) : (
              <text content="None." fg={tokens.textSecondary} />
            )}
            {dimensions.width < 40 || dimensions.height < 12 ? (
              <text content="Resize to 40 columns and 12 rows to review." fg={tokens.warning} />
            ) : null}
          </Modal>
        ) : null}
        {showMenu ? (
          <Modal
            tokens={tokens}
            title=" Search actions "
            width={58}
            height={22}
            footer={
              <>
                <text content="↑↓ choose · Enter open · Esc close" fg={tokens.textMuted} />
                <box flexDirection="row" flexWrap="wrap" gap={1}>
                  <ActionButton
                    tokens={tokens}
                    label="Previous"
                    disabled={menuTop === 0}
                    onPress={() => moveMenuPage(-1)}
                  />
                  <ActionButton
                    tokens={tokens}
                    label="Next"
                    disabled={menuTop + menuPageSize >= filteredCommands.length}
                    onPress={() => moveMenuPage(1)}
                  />
                  <ActionButton tokens={tokens} label="Close" onPress={() => setMenu(false)} />
                </box>
              </>
            }
          >
            <input
              focused
              value={menuQuery}
              maxLength={128}
              placeholder="Type an action or shortcut…"
              backgroundColor={tokens.surfaceInset}
              focusedBackgroundColor={tokens.surfaceInset}
              textColor={tokens.text}
              cursorColor={tokens.accent}
              onInput={updateMenuQuery}
            />
            {dimensions.height >= 10 && dimensions.width >= 28 ? (
              <text
                content={
                  filteredCommands.length === 0
                    ? "No matching actions. Clear the search to try again."
                    : `${menuTop + 1}–${Math.min(filteredCommands.length, menuTop + menuPageSize)} of ${filteredCommands.length} actions`
                }
                fg={tokens.textMuted}
              />
            ) : (
              <text content="Resize to use actions" fg={tokens.textMuted} />
            )}
            {dimensions.height >= 10 && dimensions.width >= 28
              ? filteredCommands
                  .slice(menuTop, menuTop + menuPageSize)
                  .map((command, localIndex) => (
                    <ActionButton
                      key={command.label}
                      tokens={tokens}
                      active={menuCursor === menuTop + localIndex}
                      disabled={command.disabled}
                      label={`${command.label}${command.shortcut ? ` · ${command.shortcut}` : ""}`}
                      onPress={() => runMenuCommand(menuTop + localIndex)}
                    />
                  ))
              : null}
          </Modal>
        ) : null}
        {pendingApply ? (
          pendingSingleId !== null && !pendingSingleCandidate ? (
            <Modal tokens={tokens} title=" item unavailable " width={60}>
              <text
                content="The reviewed artifact is no longer present. Nothing will be removed."
                fg={tokens.text}
              />
              <text content="n / esc close" fg={tokens.textMuted} />
            </Modal>
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
              outsideViewCount={reviewedOutsideView}
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
