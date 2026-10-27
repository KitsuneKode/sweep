import { relative } from "node:path";
import type { RiskTier, ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { bg, bold, dim, fg, StyledText, t } from "@opentui/core";
import { AGE_LABEL_WIDTH, describeAge, formatAge, isRecent, sizeBar, lastActiveMs } from "./age.js";
import type { TextChunk } from "@opentui/core";
import type { UiDisplayRow } from "./rows.js";
import { buildDisplayRows } from "./rows.js";
import { compactBytesLabel, sidebarItemCount } from "./sidebar.js";
import type { SweepUiState, SweepUiSummary, UiFocus } from "./state.js";
import {
  activePatterns,
  getCurrentCandidate,
  patternAtCursor,
  visiblePatternRows,
} from "./state.js";
import { type ThemeTokens, riskColor } from "./theme.js";
import type { KeyInput } from "./keymap.js";
import { cellWidth, clipCells, padCells } from "./text-cells.js";

function padCount(value: number, width = 2): string {
  return value.toLocaleString().padStart(width, " ");
}

/** One-character risk glyphs - shape encodes meaning, color reinforces it. */
export const riskGlyph: Record<RiskTier, string> = {
  safe: "✓",
  caution: "!",
  dangerous: "✗",
  blocked: "⊘",
};

/**
 * Queue membership has its own shape, distinct from risk and cursor: an open
 * ring waits, a filled one is queued. The three-cell slot is the click target.
 */
export const SELECTED_MARK = " ● ";
export const UNSELECTED_MARK = " ○ ";
/**
 * A checkbox standing for many rows has three states, and each needs its own
 * shape: an open ring (none queued), a half disc (some), a full disc (all).
 * `◉` beside `●` read as the same tick at terminal size, so a folder with one
 * queued item looked fully queued.
 */
export type QueueState = "none" | "some" | "all";
export function queueState(selected: number, total: number): QueueState {
  if (selected <= 0 || total <= 0) return "none";
  return selected >= total ? "all" : "some";
}
export const QUEUE_GLYPH: Record<QueueState, string> = { none: "○", some: "◐", all: "●" };

/** Hard-locked rows offer no checkbox at all - neither queued nor queueable. */
const BLOCKED_MARK = " · ";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/**
 * Sizes read by magnitude, because size is what a cleaner is shopping for:
 * gigabytes lead, hundreds of megabytes support, everything smaller recedes.
 */
export function bytesTone(bytes: number, tokens: ThemeTokens): { color: string; strong: boolean } {
  if (bytes >= GIB) return { color: tokens.text, strong: true };
  if (bytes >= 100 * MIB) return { color: tokens.textSecondary, strong: false };
  return { color: tokens.textDim, strong: false };
}

function toned(text: string, bytes: number, tokens: ThemeTokens): TextChunk {
  const tone = bytesTone(bytes, tokens);
  return tone.strong ? bold(fg(tone.color)(text)) : fg(tone.color)(text);
}

/** Cursor, queue and risk each have a separate cell, followed by a gap. */
export const ROW_NAME_OFFSET = 8;
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
  return age + bar + (widths.sizeWidth > 0 ? SIZE_GAP + widths.sizeWidth : 0);
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
  const usable = Math.max(ROW_NAME_OFFSET, listWidth - WRAP_SAFETY);
  const sizeBudget = Math.min(SIZE_COLUMN_WIDTH, usable - ROW_NAME_OFFSET - SIZE_GAP - 1);
  const shell: RowWidths = {
    nameWidth: 0,
    sizeWidth: sizeBudget >= 5 ? sizeBudget : 0,
    ageWidth: listWidth >= AGE_MIN_LIST_WIDTH ? AGE_LABEL_WIDTH : 0,
    barWidth: listWidth >= BAR_MIN_LIST_WIDTH ? BAR_COLUMN_WIDTH : 0,
  };
  return { ...shell, nameWidth: Math.max(0, usable - ROW_NAME_OFFSET - tailWidth(shell)) };
}

export function relativePath(root: string, path: string): string {
  const result = relative(root, path);
  // Backslash is a legal filename character on POSIX, not a separator.
  return process.platform === "win32" ? result.replaceAll("\\", "/") : result;
}

export function buildListColumnHeader(widths: RowWidths, tokens: ThemeTokens): StyledText {
  const nameLabel = padCells("Name", widths.nameWidth);
  const ageLabel =
    widths.ageWidth > 0 ? `${" ".repeat(COLUMN_GAP)}${"Idle".padStart(widths.ageWidth)}` : "";
  const barGap = widths.barWidth > 0 ? " ".repeat(COLUMN_GAP + widths.barWidth) : "";
  const sizeLabel = padCells("Size", widths.sizeWidth, "right");
  return t`${" ".repeat(ROW_NAME_OFFSET)}${fg(tokens.textDim)(nameLabel)}${fg(tokens.textDim)(ageLabel)}${barGap}${" ".repeat(widths.sizeWidth > 0 ? SIZE_GAP : 0)}${fg(tokens.textDim)(sizeLabel)}`;
}

export function buildListRule(widths: RowWidths, tokens: ThemeTokens): StyledText {
  return t`${fg(tokens.border)("─".repeat(Math.max(8, rowTotalWidth(widths))))}`;
}

export function buildGroupHeaderContent(
  row: Extract<UiDisplayRow, { kind: "header" }>,
  tokens: ThemeTokens,
  widths: RowWidths,
): StyledText {
  const glyph = fg(tokens.textDim)(row.collapsed ? "▸" : "▾");
  // A lone artifact's header already names its folder; "1 ·" only adds noise.
  const count = row.itemCount > 1 ? `${row.itemCount} · ` : "";
  // Same unit spacing as the item rows below, so the size column reads as one.
  const bytes = formatBytes(row.bytes);
  // A partly queued group must not read like a fully queued one.
  const fullyQueued = row.selectedCount === row.itemCount;
  const queued =
    row.selectedCount === 0
      ? ""
      : fullyQueued
        ? ` · ${row.selectedCount} queued`
        : ` · ${row.selectedCount} of ${row.itemCount} queued`;
  const total = rowTotalWidth(widths);
  const full = `${count}${bytes}${queued}`;
  const fits = cellWidth(full) <= total - 7;
  const shownCount = fits || cellWidth(`${count}${bytes}`) <= total - 7 ? count : "";
  const shownQueued = fits ? queued : "";
  const statsWidth = cellWidth(`${shownCount}${bytes}${shownQueued}`);
  const labelWidth = Math.max(0, total - 2 - statsWidth - 1);
  const label = truncateScopeLabel(row.label, labelWidth);
  // The project folder names the group; the path that leads to it recedes.
  const trimmed = label.trimEnd();
  const cut = trimmed.replace(/\/$/, "").lastIndexOf("/") + 1;
  const lead = trimmed.slice(0, cut);
  const leaf = trimmed.slice(cut);
  const pad = " ".repeat(Math.max(0, cellWidth(label) - cellWidth(trimmed)));
  const queuedColor = fullyQueued ? tokens.positive : tokens.textSecondary;
  return new StyledText([
    glyph,
    fg(tokens.textDim)(" "),
    fg(tokens.textMuted)(lead),
    bold(fg(tokens.text)(leaf)),
    fg(tokens.textDim)(`${pad} ${shownCount}`),
    toned(bytes, row.bytes, tokens),
    ...(shownQueued ? [fg(queuedColor)(shownQueued)] : []),
  ]);
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
  return buildArtifactRow(candidate, selected, isCurrent, widths, tokens, root, groupLabel, metrics)
    .content;
}

/** Where a row's size bar sits and what it shows, for drawing it in pixels. */
export interface RowBar {
  /** First cell of the bar column, from the row's left edge. */
  column: number;
  width: number;
  fraction: number;
  color: string;
}

/**
 * The row's text plus its size bar. With `barGap` the bar column is left as
 * blank cells and returned as `bar`, so a kitty image can be laid over it.
 */
export function buildArtifactRow(
  candidate: ScanCandidate,
  selected: boolean,
  isCurrent: boolean,
  widths: RowWidths,
  tokens: ThemeTokens,
  root?: string,
  groupLabel?: string,
  metrics?: RowMetrics,
  barGap = false,
): { content: StyledText; bar: RowBar | null } {
  let rowBar: RowBar | null = null;
  const colors = riskColor(tokens);
  const rail = isCurrent ? fg(tokens.accent)("▌") : fg(tokens.textDim)(" ");
  const blocked = candidate.riskTier === "blocked";
  // Queue and risk have independent shapes, even on a focused or monochrome row.
  const markShape = blocked ? BLOCKED_MARK : selected ? SELECTED_MARK : UNSELECTED_MARK;
  // The ring says queued or not; the risk glyph beside it says how risky.
  // Only dangerous rings keep their colour - rare enough that it should shout.
  const markColor = isCurrent
    ? tokens.selectionText
    : blocked
      ? tokens.blocked
      : selected
        ? tokens.accent
        : candidate.riskTier === "dangerous"
          ? colors.dangerous
          : tokens.textDim;
  const mark = fg(markColor)(markShape);
  // Safe is the common case; its mark recedes so caution and danger stand out.
  const risk = fg(
    isCurrent
      ? tokens.selectionText
      : candidate.riskTier === "safe"
        ? tokens.textDim
        : colors[candidate.riskTier],
  )(riskGlyph[candidate.riskTier]);
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
  const sizeTone = bytesTone(candidate.estimatedBytes, tokens);
  const sizeColor = isCurrent ? tokens.selectionText : selected ? tokens.accent : sizeTone.color;
  const nameStyled =
    parentText.length > 0
      ? t`${fg(nameColor)(nameText)}${fg(parentColor)(parentText)}`
      : t`${fg(nameColor)(nameText)}`;

  const parts = [t`${rail} ${mark} ${risk} `, nameStyled];
  if (widths.ageWidth > 0) {
    // Touched within the week reads as "probably in use": the one age the
    // eye should catch before deleting.
    const recent = metrics !== undefined && isRecent(lastActiveMs(candidate), metrics.now);
    // Recent means "in use", not "risky": it takes the info hue, so orange
    // stays reserved for the caution tier.
    const ageColor = isCurrent ? tokens.selectionText : recent ? tokens.info : tokens.textDim;
    const age = metrics ? formatAge(lastActiveMs(candidate), metrics.now) : "";
    parts.push(
      t`${" ".repeat(COLUMN_GAP)}${fg(ageColor)(padCells(age, widths.ageWidth, "right"))}`,
    );
  }
  if (widths.barWidth > 0) {
    const barColor = isCurrent
      ? tokens.selectionText
      : selected
        ? tokens.accent
        : sizeTone.strong
          ? tokens.textMuted
          : tokens.border;
    if (barGap) {
      const maxBytes = metrics?.maxBytes ?? 0;
      rowBar = {
        column: parts.reduce((sum, part) => sum + styledWidth(part), 0) + COLUMN_GAP,
        width: widths.barWidth,
        fraction: maxBytes > 0 ? Math.min(1, Math.max(0, candidate.estimatedBytes / maxBytes)) : 0,
        color: barColor,
      };
      parts.push(t`${" ".repeat(COLUMN_GAP + widths.barWidth)}`);
    } else {
      const bar = sizeBar(candidate.estimatedBytes, metrics?.maxBytes ?? 0, widths.barWidth);
      parts.push(t`${" ".repeat(COLUMN_GAP)}${fg(barColor)(bar)}`);
    }
  }
  if (widths.sizeWidth > 0) {
    const sizeChunk = sizeTone.strong ? bold(fg(sizeColor)(size)) : fg(sizeColor)(size);
    parts.push(t`${" ".repeat(SIZE_GAP)}${sizeChunk}`);
  }
  return { content: joinStyled(parts), bar: rowBar };
}

function styledWidth(text: Pick<StyledText, "chunks">): number {
  return text.chunks.reduce((sum, chunk) => sum + cellWidth(chunk.text), 0);
}

/** Directory that contains the artifact, relative to the scan root. */
export function artifactParentLabel(root: string, path: string): string {
  const rel = relativePath(root, path);
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

  const minName = Math.min(cellWidth(name), width);
  const parentBudget = width - minName - 2;
  if (parentBudget < 4) {
    return { nameText: truncateEnd(name, width), parentText: "" };
  }

  // The folder follows the name it qualifies; the cell pads after it, so
  // paths start where the eye already is instead of floating to the edge.
  const parentShown = truncateMiddle(parent, parentBudget);
  return {
    nameText: name,
    parentText: padCells(`  ${parentShown}`, width - cellWidth(name)),
  };
}

function formatSizeCell(bytes: number, width: number, partial: boolean): string {
  // `~` marks a partial lower bound (unreadable inodes inside the subtree) -
  // pending stubs carry bytes=0 and still render "-" until their size lands.
  let label = bytes > 0 ? `${partial ? "~" : ""}${formatBytes(bytes)}` : partial ? "~0" : "-";
  if (cellWidth(label) > width) label = label.replace(" ", "");
  if (cellWidth(label) > width && bytes > 0)
    label = `${partial ? "~" : ""}${compactBytesLabel(bytes)}`;
  if (cellWidth(label) > width) label = "large";
  return padCells(label, width, "right");
}

function truncateEnd(value: string, max: number): string {
  return padCells(value, max);
}

/**
 * Keep a scope label identifiable in a tight column.
 * Paths prefer the last two segments; otherwise middle-ellipsis.
 * Never chops a short phrase into `…oject root`.
 */
export function truncateScopeLabel(label: string, max: number): string {
  if (max <= 0) return "";
  label = sanitizeTerminalText(label);
  if (cellWidth(label) <= max) return padCells(label, max);

  const trailingSlash = label.endsWith("/");
  const segments = label
    .replace(/\/$/, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length >= 2) {
    const tail = `${segments.slice(-2).join("/")}${trailingSlash ? "/" : ""}`;
    if (cellWidth(tail) <= max) return padCells(tail, max);
    return padCells(truncateMiddle(tail, max), max);
  }

  return padCells(truncateMiddle(label, max), max);
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
  /** The ledger band already states the queue; the header line drops it. */
  omitQueue = false,
): StyledText {
  const w = width ?? Number.POSITIVE_INFINITY;
  const parts: StyledText[] = [];

  if (w < 50) {
    // Fit complete facts; never cut a byte value/unit at the terminal edge.
    const modes = [dryRun ? "DRY RUN" : "", trash ? "TRASH" : ""].filter(Boolean).join(" · ");
    if (omitQueue) {
      return t`${fg(modes ? tokens.info : tokens.textMuted)(modes || `${summary.visibleCount.toLocaleString()} found`)}`;
    }
    const queue = `${summary.selectedCount} queued`;
    const bytes = `${summary.selectedBytesPartial ? "~" : ""}${compactBytesLabel(summary.selectedBytes)}`;
    const budget = Math.max(0, w - 5); // outer padding, compact brand and separation
    const full = [modes, queue, bytes].filter(Boolean).join(" · ");
    const reduced = [modes, queue].filter(Boolean).join(" · ");
    const label =
      cellWidth(full) <= budget ? full : cellWidth(reduced) <= budget ? reduced : modes || queue;
    return t`${fg(dryRun || trash ? tokens.info : tokens.accent)(label)}`;
  }

  // Put operation modes first; optional counts and diagnostics may clip later.
  if (dryRun) parts.push(t`${bold(fg(tokens.warning)("DRY RUN"))}`);
  if (trash) parts.push(t`${bold(fg(tokens.info)("TRASH"))}`);

  // Under ~100 cols the found count is the first thing to go - the queue is
  // what a destructive keystroke acts on, so it always survives.
  if (w >= 100) {
    parts.push(t`${fg(tokens.textMuted)(`${padCount(summary.visibleCount)} found`)}`);
  }

  if (summary.selectedCount > 0 && !omitQueue) {
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
  return concatStyled(
    t`${fg(tokens.textDim)("queue: ")}`,
    joinStyled(interleave(parts, t`${dim(" · ")}`)),
  );
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
  return clipCells(value, max, true);
}

export function buildContextLine(state: SweepUiState, tokens: ThemeTokens): StyledText {
  if (state.focus === "patterns" || state.focus === "patternInput") {
    const enabled = activePatterns(state).length;
    const dirty = state.patternsDirty ? "*" : "";
    // The cursor row's note is the teaching surface - "bundler output -
    // generic name" explains the toggle better than a bare count ever could.
    const cursor = patternAtCursor(state);
    const detail = cursor
      ? `  ·  ${sanitizeTerminalText(cursor)}`
      : state.patternFilter.length > 0
        ? "  ·  no matches"
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
          ? t`  ${dim("·")}  ${fg(tokens.positive)(`${row.selectedCount} queued`)}`
          : "";
      return concatStyled(
        t`${fg(tokens.textMuted)(sanitizeTerminalText(row.label))}  ${fg(tokens.textDim)(`${row.itemCount} item${row.itemCount === 1 ? "" : "s"} · ${compactBytesLabel(row.bytes)}`)}`,
        ...(queued ? [queued] : []),
        t`  ${fg(tokens.textDim)(row.collapsed ? "· l/space expands" : "· h/space collapses")}`,
      );
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
  // Say which clock this is: "worked on 3 months ago" reads differently from
  // "changed 2 days ago" (a rebuild), and both matter when deciding.
  const active = lastActiveMs(candidate);
  const ageText = describeAge(active, now);
  const label = candidate.projectActiveMs !== undefined ? "project worked on" : "changed";
  const age = ageText
    ? fg(isRecent(active, now) ? tokens.info : tokens.textMuted)(`  ${label} ${ageText}`)
    : "";
  const path = fg(tokens.textSecondary)(truncateMiddle(sanitizeTerminalText(candidate.path), 64));
  const flag = candidate.isSymlink
    ? fg(tokens.warning)(" symlink")
    : candidate.reasons.includes("workspace-stub")
      ? fg(tokens.textMuted)(" stub")
      : "";

  return t`${glyph}  ${kind}  ${size}${age}  ${path}${flag}`;
}

/** A key rendered as a keycap: ` space ` on the control fill. */
export function keycap(label: string, tokens: ThemeTokens) {
  return bg(tokens.controlBg)(fg(tokens.text)(` ${label} `));
}

/** Which key hints the statusline should show. Modals own the footer too. */
export type FooterContext =
  | { kind: "confirm" }
  | { kind: "configSave" }
  | { kind: "help" }
  | { kind: "inspect" }
  | { kind: "visual" }
  | { kind: "scanError" }
  | { kind: "applying" }
  | { kind: "pane"; focus: UiFocus };

/**
 * One statusline hint: the key as shown, what it does, and the keypress a
 * click on it sends. A hint with no `press` (↑↓ move) is a description only.
 */
export interface FooterHint {
  key: string;
  label: string;
  press?: KeyInput;
}

const press = (name: string, ctrl = false): KeyInput => (ctrl ? { name, ctrl } : { name });

/**
 * Statusline key hints.
 *
 * Every reachable state names its own keys - including the overlays, which
 * previously covered the footer and left the user with no visible way out.
 * Each hint is also a button: a click sends the same key through the keymap.
 */
export function footerHintItems(
  context: FooterContext,
  options: {
    dryRun?: boolean;
    patternsDirty?: boolean;
    compact?: boolean;
    medium?: boolean;
    /** Something is queued: the review key joins the list hints. */
    queued?: boolean;
  } = {},
): FooterHint[] {
  const h = (key: string, label: string, sent?: KeyInput): FooterHint =>
    sent ? { key, label, press: sent } : { key, label };
  const move = h("↑↓", "move");
  const queue = h("space", "queue", press("space"));
  const keys = h("?", "keys", press("?"));
  const actions = h("Ctrl+K", "actions", press("k", true));
  const quit = h("ctrl-c", "quit", press("c", true));
  const review = options.queued ? [h("c", "review", press("c"))] : [];

  // Narrow terminals: never clip a hint mid-word - swap to a minimal set.
  // Modal hints are already short enough to survive, so this only rewrites
  // the long pane hint rows.
  // With a queue, the review key outranks "↑↓ move", which is only a description.
  if (options.compact && context.kind === "pane")
    return review.length > 0 ? [queue, ...review, keys] : [move, queue, keys];
  // Mid widths keep the actions palette, the way to everything else.
  if (options.medium && context.kind === "pane" && context.focus === "list")
    return [move, queue, ...review, actions, keys];

  switch (context.kind) {
    case "confirm":
      // One hint per distinct action - "n cancel · esc back" says one thing twice.
      return [
        h("y", "confirm", press("y")),
        h("n/esc", "cancel", press("escape")),
        h("t", "trash", press("t")),
        quit,
      ];
    case "configSave":
      return [h("y", "save patterns", press("y")), h("n/esc", "cancel", press("escape"))];
    case "help":
      return [h("esc", "close", press("escape")), quit];
    case "inspect":
      return [h("i/esc", "close", press("escape")), quit];
    case "visual":
      return [
        h("↑↓", "extend"),
        h("space", "queue range", press("space")),
        h("v/esc", "cancel", press("escape")),
      ];
    case "scanError":
      return [
        h("r", "retry", press("r")),
        h("esc", "dismiss", press("escape")),
        h("q", "quit", press("q")),
      ];
    case "applying":
      return [h("ctrl-c", "stop scheduling - report still lands", press("c", true))];
    case "pane":
      break;
  }

  switch (context.focus) {
    case "patterns":
      return [
        h("space", "toggle", press("space")),
        h("/", "find", press("/")),
        h("a", "add", press("a")),
        h("d", "del custom", press("d")),
        h("w", "save .sweeprc", press("w")),
        h("r", options.patternsDirty ? "rescan*" : "rescan", press("r")),
        h("esc", "back", press("escape")),
      ];
    case "patternInput":
      return [h("enter", "done", press("return")), h("esc", "back", press("escape")), quit];
    case "sidebar":
      return [
        move,
        h("l/h", "expand/fold"),
        h("enter", "browse", press("return")),
        h("space", "queue folder", press("space")),
        keys,
      ];
    case "search":
      return [
        h("enter", "list", press("return")),
        h("esc", "clear", press("escape")),
        h("tab", "panes", press("tab")),
        quit,
      ];
    default:
      return [
        move,
        queue,
        ...review,
        h("enter", "details", press("return")),
        actions,
        h("/", "filter", press("/")),
      ];
  }
}

/** The hints as one styled line: keys as keycaps, spacing between hints. */
export function buildFooterHints(
  context: FooterContext,
  tokens: ThemeTokens,
  options: { dryRun?: boolean; patternsDirty?: boolean; compact?: boolean; medium?: boolean } = {},
): StyledText {
  return new StyledText(
    footerHintItems(context, options).flatMap((item, index) => [
      ...(index > 0 ? [fg(tokens.textMuted)("  ")] : []),
      keycap(item.key, tokens),
      fg(tokens.textMuted)(` ${item.label}`),
    ]),
  );
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
  /** The containing row can render the active-view cue in its own column. */
  markActive?: boolean;
  countWidth: number;
  bytesWidth: number;
  maxLabelWidth?: number;
  showBytes?: boolean;
  /** Cells for a share-of-space bar before the bytes; 0 hides it. */
  barWidth?: number;
  /** Largest sibling-or-root byte count the bar scales against. */
  maxBytes?: number;
  tokens: ThemeTokens;
}

/** Dense scope row: tree guide · disclosure · label · count · bytes. */
export function buildSidebarLine(options: SidebarLineOptions): StyledText {
  return buildSidebarRow(options).content;
}

/**
 * The scope row plus its share-of-space bar. With `barGap` the bar's cells
 * are left blank and returned as `bar`, for a kitty image to cover.
 */
export function buildSidebarRow(options: SidebarLineOptions & { barGap?: boolean }): {
  content: StyledText;
  bar: RowBar | null;
} {
  const {
    label,
    count,
    bytes,
    selectedCount = 0,
    state,
    guide = "",
    branch = " ",
    markActive = true,
    countWidth,
    bytesWidth,
    maxLabelWidth = 14,
    showBytes = true,
    barWidth = 0,
    maxBytes = 0,
    tokens,
  } = options;

  const onPath = state === "active" || state === "ancestor" || state === "cursor";

  // The guide lights up along the path to the active scope, so a nested
  // selection stays traceable back to its root at a glance.
  const guideColor = state === "ancestor" || state === "active" ? tokens.accent : tokens.textDim;
  const guideStyled = guide.length > 0 ? fg(guideColor)(guide) : "";

  const marker =
    markActive && state === "active" && branch === " "
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
  const labelText = truncateScopeLabel(label, Math.max(1, maxLabelWidth));
  const styledLabel = onPath
    ? bold(fg(labelColor)(labelText))
    : fg(tokens.textSecondary)(labelText);

  const countStyled = fg(tokens.textDim)(
    sidebarItemCount(count, selectedCount).padStart(countWidth),
  );
  const bytesText = toned(compactBytesLabel(bytes).padStart(bytesWidth), bytes, tokens);
  // ncdu-style share of space: the eye finds the heavy folders before it reads.
  const barColor = bytesTone(bytes, tokens).strong ? tokens.textMuted : tokens.border;
  const hasBar = showBytes && barWidth > 0;
  const bar = !hasBar
    ? ""
    : options.barGap
      ? " ".repeat(barWidth)
      : fg(barColor)(sizeBar(bytes, maxBytes, barWidth));

  const countPart = countWidth > 0 ? t`  ${countStyled}` : t``;
  const head = concatStyled(t`${guideStyled}${marker} ${styledLabel}`, countPart);
  if (!showBytes) return { content: head, bar: null };
  return {
    content: concatStyled(head, t`  ${bar}${bar ? " " : ""}${bytesText}`),
    bar:
      hasBar && options.barGap
        ? {
            column: styledWidth(head) + 2,
            width: barWidth,
            fraction: maxBytes > 0 ? Math.min(1, Math.max(0, bytes / maxBytes)) : 0,
            color: barColor,
          }
        : null,
  };
}

/**
 * What an in-session removal did, in the order someone reads it: what went
 * and what it freed, then only what still needs attention. Zero counts are
 * left out; they are noise beside the answer.
 */
export function applyNotice(result: {
  removed: number;
  /** The one item's path, when exactly one was reviewed. */
  what?: string | undefined;
  trash: boolean;
  freedBytes: number;
  stillQueued: number;
  failed: number;
  unattempted: number;
  stopped: boolean;
  firstFailure?: string | undefined;
}): string {
  const items =
    result.what ?? `${result.removed.toLocaleString()} item${result.removed === 1 ? "" : "s"}`;
  const verb = result.trash ? "moved to trash" : "removed";
  const parts = [
    result.removed > 0
      ? `${result.stopped ? "stopped · " : "✓ "}${verb} ${items} · ~${formatBytes(result.freedBytes)} freed`
      : `${result.stopped ? "stopped · " : ""}nothing ${verb}`,
  ];
  if (result.failed > 0)
    parts.push(`${result.failed} failed${result.firstFailure ? `: ${result.firstFailure}` : ""}`);
  if (result.unattempted > 0) parts.push(`${result.unattempted} not attempted`);
  if (result.stillQueued > 0) parts.push(`${result.stillQueued.toLocaleString()} still queued`);
  return parts.join(" · ");
}
