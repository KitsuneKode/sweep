import { relative } from "node:path";
import type { RiskTier, ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { bold, dim, fg, StyledText, t } from "@opentui/core";
import { AGE_LABEL_WIDTH, describeAge, formatAge, isRecent, sizeBar } from "./age.js";
import type { TextChunk } from "@opentui/core";
import type { UiDisplayRow } from "./rows.js";
import { buildDisplayRows } from "./rows.js";
import { compactBytesLabel } from "./sidebar.js";
import type { SweepUiState, SweepUiSummary, UiFocus } from "./state.js";
import {
  activePatterns,
  getCurrentCandidate,
  patternAtCursor,
  visiblePatternRows,
} from "./state.js";
import { type ThemeTokens, riskColor } from "./theme.js";

function padCount(value: number, width = 2): string {
  return String(value).padStart(width, " ");
}

/** One-character risk glyphs - shape encodes meaning, color reinforces it. */
export const riskGlyph: Record<RiskTier, string> = {
  safe: "✓",
  caution: "!",
  dangerous: "✗",
  blocked: "⊘",
};

/** Selection markers - filled means queued for deletion. */
export const SELECTED_MARK = "●";
export const UNSELECTED_MARK = "○";
/** Hard-locked rows - neither queued nor queueable. */
const BLOCKED_MARK = "⊘";

/** Columns consumed before the artifact name: rail + gap + marker + gap. */
export const ROW_NAME_OFFSET = 4;
const SIZE_COLUMN_WIDTH = 9;
const SIZE_GAP = 2;
/** Extra cells reserved so a scrollbar or wide glyph cannot wrap the row. */
const WRAP_SAFETY = 2;

const COLUMN_GAP = 1;
const BAR_COLUMN_WIDTH = 4;
/** Narrowest list pane that still has room for the age column. */
const AGE_MIN_LIST_WIDTH = 56;
/** Narrowest list pane that also has room for the size bar. */
const BAR_MIN_LIST_WIDTH = 72;

export interface RowWidths {
  nameWidth: number;
  sizeWidth: number;
  /** 0 when the pane is too narrow to show the age column. */
  ageWidth: number;
  /** 0 when the pane is too narrow to show the size bar. */
  barWidth: number;
}

/** Live values the row needs to draw age and size bars. */
export interface RowMetrics {
  now: number;
  /** Largest artifact currently listed; the size bar scales against it. */
  maxBytes: number;
}

function tailWidth(widths: RowWidths): number {
  const age = widths.ageWidth > 0 ? COLUMN_GAP + widths.ageWidth : 0;
  const bar = widths.barWidth > 0 ? COLUMN_GAP + widths.barWidth : 0;
  return age + bar + SIZE_GAP + widths.sizeWidth;
}

/** Full character width of a row: rail, marker, name and every trailing column. */
export function rowTotalWidth(widths: RowWidths): number {
  return ROW_NAME_OFFSET + widths.nameWidth + tailWidth(widths);
}

/**
 * Column math shared by rows and the column header so they always align.
 * Detail is shed with width: the size bar goes first, then the age column.
 */
export function artifactRowWidths(listWidth: number): RowWidths {
  const usable = Math.max(24, listWidth - WRAP_SAFETY);
  const shell: RowWidths = {
    nameWidth: 0,
    sizeWidth: SIZE_COLUMN_WIDTH,
    ageWidth: listWidth >= AGE_MIN_LIST_WIDTH ? AGE_LABEL_WIDTH : 0,
    barWidth: listWidth >= BAR_MIN_LIST_WIDTH ? BAR_COLUMN_WIDTH : 0,
  };
  return { ...shell, nameWidth: Math.max(12, usable - ROW_NAME_OFFSET - tailWidth(shell)) };
}

export function relativePath(root: string, path: string): string {
  return relative(root, path);
}

export function buildListColumnHeader(widths: RowWidths, tokens: ThemeTokens): StyledText {
  const nameLabel = "Name";
  const namePad = " ".repeat(Math.max(0, widths.nameWidth - nameLabel.length));
  const ageLabel =
    widths.ageWidth > 0 ? `${" ".repeat(COLUMN_GAP)}${"Age".padStart(widths.ageWidth)}` : "";
  const barGap = widths.barWidth > 0 ? " ".repeat(COLUMN_GAP + widths.barWidth) : "";
  const sizeLabel = "Size".padStart(widths.sizeWidth);
  return t`${" ".repeat(ROW_NAME_OFFSET)}${fg(tokens.textDim)(nameLabel)}${namePad}${fg(tokens.textDim)(ageLabel)}${barGap}${" ".repeat(SIZE_GAP)}${fg(tokens.textDim)(sizeLabel)}`;
}

export function buildListRule(widths: RowWidths, tokens: ThemeTokens): StyledText {
  return t`${fg(tokens.border)("─".repeat(Math.max(8, rowTotalWidth(widths))))}`;
}

export function buildGroupHeaderContent(
  row: Extract<UiDisplayRow, { kind: "header" }>,
  tokens: ThemeTokens,
  widths: RowWidths,
): StyledText {
  const glyph = row.collapsed ? fg(tokens.textDim)("▸") : fg(tokens.accent)("▾");
  const stats = `${row.itemCount} · ${compactBytesLabel(row.bytes)}`;
  // A partly queued group must not read like a fully queued one.
  const fullyQueued = row.selectedCount === row.itemCount;
  const queued =
    row.selectedCount === 0
      ? ""
      : fullyQueued
        ? ` · ${row.selectedCount} queued`
        : ` · ${row.selectedCount} of ${row.itemCount} queued`;
  const total = rowTotalWidth(widths);
  const labelWidth = Math.max(4, total - 2 - stats.length - queued.length - 1);
  const label = truncateScopeLabel(row.label, labelWidth);
  const statsStyled =
    row.selectedCount === 0
      ? fg(tokens.textDim)(stats)
      : fg(fullyQueued ? tokens.positive : tokens.textSecondary)(`${stats}${queued}`);
  return t`${glyph} ${bold(fg(tokens.textMuted)(label))} ${statsStyled}`;
}

export function buildArtifactRowContent(
  candidate: ScanCandidate,
  selected: boolean,
  isCurrent: boolean,
  widths: RowWidths,
  tokens: ThemeTokens,
  root?: string,
  groupLabel?: string,
  metrics?: RowMetrics,
): StyledText {
  const colors = riskColor(tokens);
  const rail = isCurrent ? fg(tokens.accent)("▌") : fg(tokens.textDim)(" ");
  const blocked = candidate.riskTier === "blocked";
  // One status cell carries both facts: shape = queued state, color = risk.
  // ● accent   queued, safe        ● warning  queued, caution
  // ● danger   queued, dangerous   ○ dim/tint unselected (tint = its risk)
  // ⊘          blocked - locked out of queueing entirely
  const markShape = blocked ? BLOCKED_MARK : selected ? SELECTED_MARK : UNSELECTED_MARK;
  const markColor = isCurrent
    ? tokens.selectionText
    : blocked
      ? tokens.blocked
      : candidate.riskTier === "safe"
        ? selected
          ? tokens.accent
          : tokens.textDim
        : colors[candidate.riskTier];
  const mark = fg(markColor)(markShape);
  // The parent path earns its column only when it says something the group
  // header above the row does not already say.
  const parent = root ? artifactParentLabel(root, candidate.path) : "";
  const redundantParent =
    parent.length > 0 &&
    groupLabel !== undefined &&
    groupLabel.replace(/\/+$/, "") === parent.replace(/\\/g, "/").replace(/\/+$/, "");
  const { nameText, parentText } = splitNameCell(
    candidate.name,
    redundantParent ? "" : parent,
    widths.nameWidth,
  );
  // Name color is reserved for the tiers that need to shout: dangerous and
  // blocked. Caution is the common case - the trailing glyph carries it, and
  // painting every caution name warning-colored would just make a 600-row
  // list into a wall of orange.
  const nameColor = isCurrent
    ? tokens.selectionText
    : blocked
      ? tokens.blocked
      : candidate.riskTier === "dangerous"
        ? tokens.danger
        : tokens.text;
  const parentColor = isCurrent ? tokens.selectionText : tokens.textDim;
  const size = formatSizeCell(
    candidate.estimatedBytes,
    widths.sizeWidth,
    candidate.bytesKnown === false,
  );
  const sizeColor = isCurrent
    ? tokens.selectionText
    : selected
      ? tokens.positive
      : tokens.textSecondary;
  const nameStyled =
    parentText.length > 0
      ? t`${fg(nameColor)(nameText)}${fg(parentColor)(parentText)}`
      : t`${fg(nameColor)(nameText)}`;

  const parts = [t`${rail} ${mark} `, nameStyled];
  if (widths.ageWidth > 0) {
    // Touched within the week reads as "probably in use": the one age the
    // eye should catch before deleting.
    const recent = metrics !== undefined && isRecent(candidate.modifiedMs, metrics.now);
    const ageColor = isCurrent ? tokens.selectionText : recent ? tokens.warning : tokens.textDim;
    const age = metrics ? formatAge(candidate.modifiedMs, metrics.now) : "";
    parts.push(t`${" ".repeat(COLUMN_GAP)}${fg(ageColor)(age.padStart(widths.ageWidth))}`);
  }
  if (widths.barWidth > 0) {
    const barColor = isCurrent ? tokens.selectionText : selected ? tokens.accent : tokens.textDim;
    const bar = sizeBar(candidate.estimatedBytes, metrics?.maxBytes ?? 0, widths.barWidth);
    parts.push(t`${" ".repeat(COLUMN_GAP)}${fg(barColor)(bar)}`);
  }
  parts.push(t`${" ".repeat(SIZE_GAP)}${fg(sizeColor)(size)}`);
  return joinStyled(parts);
}

/** Directory that contains the artifact, relative to the scan root. */
export function artifactParentLabel(root: string, path: string): string {
  const rel = relativePath(root, path).replaceAll("\\", "/");
  const slash = rel.lastIndexOf("/");
  if (slash <= 0) return "";
  return rel.slice(0, slash);
}

/** Command-style primary name plus muted location, padded to a fixed column. */
export function splitNameCell(
  name: string,
  parent: string,
  width: number,
): { nameText: string; parentText: string } {
  // Filenames are attacker-controlled bytes - escape terminal controls before
  // they reach the cell buffer, or a hostile dirname injects ANSI into the TUI.
  name = sanitizeTerminalText(name);
  parent = sanitizeTerminalText(parent);
  if (width <= 0) return { nameText: "", parentText: "" };
  if (parent.length === 0) {
    return { nameText: truncateEnd(name, width), parentText: "" };
  }

  const minName = Math.min(name.length, Math.max(4, Math.min(name.length, width)));
  const parentBudget = width - minName - 1;
  if (parentBudget < 4) {
    return { nameText: truncateEnd(name, width), parentText: "" };
  }

  const parentShown = truncateMiddle(parent, parentBudget);
  const nameBudget = width - parentShown.length - 1;
  const nameShown =
    name.length <= nameBudget ? name : `${name.slice(0, Math.max(1, nameBudget - 1))}…`;
  const namePadded = nameShown.padEnd(nameBudget);
  return { nameText: namePadded, parentText: ` ${parentShown}` };
}

function formatSizeCell(bytes: number, width: number, partial: boolean): string {
  // `~` marks a partial lower bound (unreadable inodes inside the subtree) -
  // pending stubs carry bytes=0 and still render "-" until their size lands.
  const label = bytes > 0 ? `${partial ? "~" : ""}${formatBytes(bytes)}` : partial ? "~0" : "-";
  return label.padStart(width);
}

function truncateEnd(value: string, max: number): string {
  if (value.length <= max) return value.padEnd(max);
  return `${value.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Keep a scope label identifiable in a tight column.
 * Paths prefer the last two segments; otherwise middle-ellipsis.
 * Never chops a short phrase into `…oject root`.
 */
export function truncateScopeLabel(label: string, max: number): string {
  if (max <= 0) return "";
  label = sanitizeTerminalText(label);
  if (label.length <= max) return label.padEnd(max);

  const trailingSlash = label.endsWith("/");
  const segments = label
    .replace(/\/$/, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length >= 2) {
    const tail = `${segments.slice(-2).join("/")}${trailingSlash ? "/" : ""}`;
    if (tail.length <= max) return tail.padEnd(max);
    return truncateMiddle(tail, max).padEnd(max);
  }

  return truncateMiddle(label, max).padEnd(max);
}

export function formatPatternRow(pattern: string, enabled: boolean): string {
  const mark = enabled ? "✓" : "·";
  return ` ${mark} ${sanitizeTerminalText(pattern)}`;
}

function joinStyled(segments: StyledText[]): StyledText {
  const chunks: TextChunk[] = [];
  for (const segment of segments) {
    if (segment && segment.chunks) chunks.push(...segment.chunks);
  }
  return new StyledText(chunks);
}

/** Concatenate already-styled segments (e.g. meter bar + label) into one text. */
export function concatStyled(...parts: Array<Pick<StyledText, "chunks">>): StyledText {
  return new StyledText(parts.flatMap((part) => part.chunks));
}

/**
 * Block-character progress meter, e.g. `████████░░░░`.
 * Fill uses the accent; track stays quiet.
 */
export function buildMeter(
  value: number,
  total: number,
  width: number,
  tokens: ThemeTokens,
): StyledText {
  const clampedTotal = Math.max(1, total);
  const ratio = Math.min(1, Math.max(0, value / clampedTotal));
  const filled = total <= 0 ? 0 : Math.round(ratio * width);
  const empty = Math.max(0, width - filled);

  const bar = t`${fg(tokens.accent)("█".repeat(filled))}${fg(tokens.meterTrack)("░".repeat(empty))}`;
  if (total <= 0) {
    return t`${fg(tokens.meterTrack)("░".repeat(width))}`;
  }
  return bar;
}

/** Brand header: diamond mark + wordmark on the left, stats composed separately. */
export function buildBrandLine(tokens: ThemeTokens, width?: number): StyledText {
  // Under ~44 cols the wordmark collides with the right-side stats - keep the
  // diamond as the mark and let the numbers have the space.
  if (width !== undefined && width < 44) {
    return t`${bold(fg(tokens.accent)("◆"))}`;
  }
  return t`${bold(fg(tokens.accent)("◆ sweep"))}`;
}

/** Right side of the header: found / selected / reclaimable bytes chips. */
export function buildHeaderStats(
  plan: ScanPlan,
  summary: SweepUiSummary,
  tokens: ThemeTokens,
  dryRun?: boolean,
  width?: number,
  trash?: boolean,
  /** e.g. `rust 263ms vs js 241ms` - plain engine name before any run times. */
  engine?: string,
): StyledText {
  const w = width ?? Number.POSITIVE_INFINITY;
  const parts: StyledText[] = [];

  // Under ~100 cols the found count is the first thing to go - the queue is
  // what a destructive keystroke acts on, so it always survives.
  if (w >= 100) {
    parts.push(t`${fg(tokens.textMuted)(`${padCount(summary.visibleCount)} found`)}`);
  }

  if (summary.selectedCount > 0) {
    // The queue outliving the current view is the point - you narrow, queue,
    // narrow again, then apply. Say when part of it is off screen, so a header
    // reading higher than the visible rows is explained rather than alarming.
    const hidden = summary.selectedCount - summary.visibleSelectedCount;
    const queued =
      hidden > 0 && w >= 100
        ? `${padCount(summary.selectedCount)} queued (${summary.visibleSelectedCount} shown)`
        : `${padCount(summary.selectedCount)} queued`;
    // Under 84 cols the sidebar and statusline tally are both gone - fold the
    // reclaimable bytes into the queue chip so the number a destructive
    // keystroke acts on is never invisible.
    const queuedLabel =
      w >= 84
        ? queued
        : `${queued} · ${summary.selectedBytesPartial ? "~" : ""}${formatBytes(summary.selectedBytes)}`;
    parts.push(t`${fg(tokens.accent)(queuedLabel)}`);
    if (w >= 84) {
      parts.push(
        t`${bold(fg(tokens.positive)(`${summary.selectedBytesPartial ? "~" : ""}${formatBytes(summary.selectedBytes)}`))}`,
      );
    }
  }

  // Diagnostics only - which backend scanned. Drops below the queue's floor
  // on narrow layouts; TRASH/DRY RUN are safety state and never drop.
  if (engine && w >= 110) {
    parts.push(t`${fg(tokens.textDim)(`engine:${engine}`)}`);
  }

  if (trash) {
    // Reversible mode changes what apply does - it must be visible before the
    // confirm dialog, not discovered after it.
    parts.push(t`${bold(fg(tokens.info)("TRASH"))}`);
  }
  if (dryRun) {
    parts.push(t`${bold(fg(tokens.warning)("DRY RUN"))}`);
  }

  return joinStyled(interleave(parts, t`  ${dim("·")}  `));
}

/**
 * Queue composition for the statusline tail. Bytes belong to the header -
 * repeating them here read the same fact twice in two formats. The tally's
 * job is the *mix*: one dangerous item in a sea of safe ones is the thing
 * the red confirm dialog exists for.
 */
export function buildRiskTally(summary: SweepUiSummary, tokens: ThemeTokens): StyledText {
  if (summary.selectedCount <= 0) {
    return t`${fg(tokens.textDim)("queue empty")}`;
  }
  const { safe, caution, dangerous } = summary.selectedRiskCounts;
  const parts: StyledText[] = [];
  if (safe > 0) {
    parts.push(t`${fg(tokens.positive)(`${safe} safe`)}`);
  }
  if (caution > 0) {
    parts.push(t`${fg(tokens.warning)(`${caution} caution`)}`);
  }
  if (dangerous > 0) {
    parts.push(t`${bold(fg(tokens.danger)(`${dangerous} dangerous`))}`);
  }
  return joinStyled(interleave(parts, t`${dim(" · ")}`));
}

function interleave(items: StyledText[], separator: StyledText): StyledText[] {
  const out: StyledText[] = [];
  for (const item of items) {
    if (out.length > 0) out.push(separator);
    out.push(item);
  }
  return out;
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

export function buildContextLine(state: SweepUiState, tokens: ThemeTokens): StyledText {
  if (state.focus === "patterns" || state.focus === "patternInput") {
    const enabled = activePatterns(state).length;
    const dirty = state.patternsDirty ? "*" : "";
    // The cursor row's note is the teaching surface - "bundler output -
    // generic name" explains the toggle better than a bare count ever could.
    const cursor = patternAtCursor(state);
    const detail = cursor
      ? `  ${dim("·")}  ${sanitizeTerminalText(cursor)}`
      : state.patternFilter.length > 0
        ? `  ${dim("·")}  no matches`
        : "";
    return t`${fg(tokens.textMuted)(`${enabled} on · ${visiblePatternRows(state).length} shown`)}${fg(tokens.warning)(dirty)}${fg(tokens.textDim)(detail)}`;
  }

  const candidate = getCurrentCandidate(state);
  if (!candidate) {
    // Cursor can sit on a group header (mouse click / collapsed view) - the
    // footer then describes the group, not a missing list.
    const row = buildDisplayRows(state)[state.rowIndex];
    if (row?.kind === "header") {
      const queued =
        row.selectedCount > 0
          ? `  ${dim("·")}  ${fg(tokens.positive)(`${row.selectedCount} queued`)}`
          : "";
      return t`${fg(tokens.textMuted)(sanitizeTerminalText(row.label))}  ${fg(tokens.textDim)(`${row.itemCount} item${row.itemCount === 1 ? "" : "s"} · ${compactBytesLabel(row.bytes)}`)}${queued}  ${fg(tokens.textDim)(row.collapsed ? "· l/space expands" : "· h/space collapses")}`;
    }
    return t`${fg(tokens.textDim)("No matching artifacts.")}`;
  }

  const colors = riskColor(tokens);
  const glyph = fg(colors[candidate.riskTier])(riskGlyph[candidate.riskTier]);
  const kind = fg(tokens.textMuted)(candidate.kind);
  const size = fg(tokens.textSecondary)(
    `${candidate.bytesKnown === false ? "~" : ""}${formatBytes(candidate.estimatedBytes)}`,
  );
  const now = Date.now();
  const ageText = describeAge(candidate.modifiedMs, now);
  const age = ageText
    ? fg(isRecent(candidate.modifiedMs, now) ? tokens.warning : tokens.textMuted)(`  ${ageText}`)
    : "";
  const path = fg(tokens.textSecondary)(truncateMiddle(sanitizeTerminalText(candidate.path), 64));
  const flag = candidate.isSymlink
    ? fg(tokens.warning)(" symlink")
    : candidate.reasons.includes("workspace-stub")
      ? fg(tokens.textMuted)(" stub")
      : "";

  return t`${glyph}  ${kind}  ${size}${age}  ${path}${flag}`;
}

/** Which key hints the statusline should show. Modals own the footer too. */
export type FooterContext =
  | { kind: "confirm" }
  | { kind: "help" }
  | { kind: "inspect" }
  | { kind: "visual" }
  | { kind: "scanError" }
  | { kind: "applying" }
  | { kind: "pane"; focus: UiFocus };

/**
 * Statusline key hints.
 *
 * Every reachable state names its own keys - including the overlays, which
 * previously covered the footer and left the user with no visible way out.
 */
export function buildFooterHints(
  context: FooterContext,
  tokens: ThemeTokens,
  options: { dryRun?: boolean; patternsDirty?: boolean; compact?: boolean } = {},
): StyledText {
  const key = (label: string) => fg(tokens.text)(label);
  const hint = (label: string) => fg(tokens.textMuted)(label);
  const sep = dim(" · ");

  // Narrow terminals: never clip a hint mid-word - swap to a minimal set.
  // Modal hints are already short enough to survive, so this only rewrites
  // the long pane hint rows.
  if (options.compact && context.kind === "pane") {
    return t`${key("↑↓")} ${hint("move")}${sep}${key("space")} ${hint("queue")}${sep}${key("?")} ${hint("keys")}`;
  }

  if (context.kind === "confirm") {
    // One hint per distinct action - "n cancel · esc back" says one thing twice.
    return t`${key("y")} ${hint("confirm")}${sep}${key("n/esc")} ${hint("cancel")}${sep}${key("t")} ${hint("trash")}${sep}${key("ctrl-c")} ${hint("quit")}`;
  }

  if (context.kind === "help") {
    return t`${key("esc")} ${hint("close")}${sep}${key("ctrl-c")} ${hint("quit")}`;
  }

  if (context.kind === "inspect") {
    return t`${key("i/esc")} ${hint("close")}${sep}${key("ctrl-c")} ${hint("quit")}`;
  }

  if (context.kind === "visual") {
    return t`${key("↑↓")} ${hint("extend")}${sep}${key("space")} ${hint("queue range")}${sep}${key("v/esc")} ${hint("cancel")}`;
  }

  if (context.kind === "scanError") {
    return t`${key("r")} ${hint("retry")}${sep}${key("esc")} ${hint("dismiss")}${sep}${key("q")} ${hint("quit")}`;
  }

  if (context.kind === "applying") {
    return t`${key("ctrl-c")} ${hint("stop scheduling - report still lands")}`;
  }

  if (context.focus === "patterns") {
    const rescan = options.patternsDirty ? "rescan*" : "rescan";
    return t`${key("space")} ${hint("toggle")}${sep}${key("/")} ${hint("find")}${sep}${key("a")} ${hint("add")}${sep}${key("d")} ${hint("del custom")}${sep}${key("w")} ${hint("save .sweeprc")}${sep}${key("r")} ${hint(rescan)}${sep}${key("esc")} ${hint("back")}`;
  }

  if (context.focus === "patternInput") {
    return t`${key("enter")} ${hint("done")}${sep}${key("esc")} ${hint("back")}${sep}${key("ctrl-c")} ${hint("quit")}`;
  }

  if (context.focus === "sidebar") {
    return t`${key("↑↓")} ${hint("move")}${sep}${key("l/h")} ${hint("open/close")}${sep}${key("enter")} ${hint("scope")}${sep}${key("space")} ${hint("queue")}${sep}${key("u")} ${hint("clear queue")}${sep}${key("?")} ${hint("help")}`;
  }

  if (context.focus === "search") {
    return t`${key("enter")} ${hint("list")}${sep}${key("esc")} ${hint("clear")}${sep}${key("tab")} ${hint("panes")}${sep}${key("ctrl-c")} ${hint("quit")}`;
  }

  return t`${key("↑↓")} ${hint("move")}${sep}${key("space")} ${hint("queue")}${sep}${key("x")} ${hint("delete row")}${sep}${key("enter")} ${hint(options.dryRun ? "done" : "apply")}${sep}${key("i")} ${hint("inspect")}${sep}${key("/")} ${hint("filter")}${sep}${key("?")} ${hint("help")}`;
}

/** Statusline mode segment label for the focused panel. */
export function modeLabel(focus: UiFocus, scanning = false, visual = false): string {
  if (scanning) return "SCANNING";
  if (visual) return "VISUAL";
  switch (focus) {
    case "search":
      return "SEARCH";
    case "sidebar":
      return "SCOPES";
    case "patterns":
      return "PATTERNS";
    case "patternInput":
      return "PATTERNS·EDIT";
    default:
      return "NORMAL";
  }
}

/**
 * How a scope row relates to the applied scope filter. Cursor and active are
 * deliberately different things: one is where you are looking, the other is
 * what the artifact list is actually filtered to, and conflating them is why
 * the sidebar stopped being readable.
 */
export type ScopeRowState = "cursor" | "active" | "ancestor" | "idle";

export interface SidebarLineOptions {
  label: string;
  count: number;
  bytes: number;
  selectedCount?: number;
  state: ScopeRowState;
  /** Box-drawing prefix from `buildTreeGuides`; empty at the top level. */
  guide?: string;
  /** Disclosure triangle: `▾` open, `▸` closed, space for a leaf. */
  branch?: "▸" | "▾" | " ";
  countWidth: number;
  bytesWidth: number;
  maxLabelWidth?: number;
  showBytes?: boolean;
  tokens: ThemeTokens;
}

/** Dense scope row: tree guide · disclosure · label · count · bytes. */
export function buildSidebarLine(options: SidebarLineOptions): StyledText {
  const {
    label,
    count,
    bytes,
    selectedCount = 0,
    state,
    guide = "",
    branch = " ",
    countWidth,
    bytesWidth,
    maxLabelWidth = 14,
    showBytes = true,
    tokens,
  } = options;

  const onPath = state === "active" || state === "ancestor" || state === "cursor";

  // The guide lights up along the path to the active scope, so a nested
  // selection stays traceable back to its root at a glance.
  const guideColor = state === "ancestor" || state === "active" ? tokens.accent : tokens.textDim;
  const guideStyled = guide.length > 0 ? fg(guideColor)(guide) : "";

  const marker =
    state === "active"
      ? fg(tokens.accent)("›")
      : branch === " "
        ? fg(tokens.textDim)(" ")
        : fg(state === "ancestor" ? tokens.accent : tokens.textMuted)(branch);

  const labelColor =
    state === "active" || state === "cursor"
      ? tokens.text
      : state === "ancestor"
        ? tokens.textSecondary
        : tokens.textSecondary;
  const labelText = truncateScopeLabel(label, Math.max(6, maxLabelWidth));
  const styledLabel = onPath
    ? bold(fg(labelColor)(labelText))
    : fg(tokens.textSecondary)(labelText);

  const countStyled = fg(tokens.textMuted)(String(count).padStart(countWidth));
  const bytesColor = onPath ? tokens.textSecondary : tokens.textDim;

  const base = showBytes
    ? t`${guideStyled}${marker} ${styledLabel}  ${countStyled}  ${fg(bytesColor)(compactBytesLabel(bytes).padStart(bytesWidth))}`
    : t`${guideStyled}${marker} ${styledLabel}  ${countStyled}`;

  if (selectedCount <= 0) return base;
  return joinStyled([base, t`  ${fg(tokens.positive)(`+${selectedCount}`)}`]);
}
