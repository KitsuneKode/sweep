import { relative } from "node:path";
import type { RiskTier, ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { bold, dim, fg, StyledText, t } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import type { UiDisplayRow } from "./rows.js";
import { buildDisplayRows } from "./rows.js";
import { compactBytesLabel } from "./sidebar.js";
import type { SweepUiState, SweepUiSummary, UiFocus } from "./state.js";
import { activePatterns, getCurrentCandidate } from "./state.js";
import { type ThemeTokens, riskColor } from "./theme.js";

function padCount(value: number, width = 2): string {
  return String(value).padStart(width, " ");
}

/** One-character risk glyphs — shape encodes meaning, color reinforces it. */
export const riskGlyph: Record<RiskTier, string> = {
  safe: "✓",
  caution: "!",
  dangerous: "✗",
  blocked: "⊘",
};

/** Selection markers — filled means queued for deletion. */
export const SELECTED_MARK = "●";
export const UNSELECTED_MARK = "○";
/** Hard-locked rows — neither queued nor queueable. */
const BLOCKED_MARK = "⊘";

/** Columns consumed before the artifact name: rail + gap + marker + gap. */
export const ROW_NAME_OFFSET = 4;
const SIZE_COLUMN_WIDTH = 9;
const SIZE_GAP = 2;
/** Extra cells reserved so a scrollbar or wide glyph cannot wrap the row. */
const WRAP_SAFETY = 2;

export interface RowWidths {
  nameWidth: number;
  sizeWidth: number;
}

/** Column math shared by rows and the column header so they always align. */
export function artifactRowWidths(listWidth: number): RowWidths {
  const usable = Math.max(24, listWidth - WRAP_SAFETY);
  const tail = SIZE_COLUMN_WIDTH + SIZE_GAP;
  return {
    nameWidth: Math.max(12, usable - ROW_NAME_OFFSET - tail),
    sizeWidth: SIZE_COLUMN_WIDTH,
  };
}

export function relativePath(root: string, path: string): string {
  return relative(root, path);
}

export function buildListColumnHeader(widths: RowWidths, tokens: ThemeTokens): StyledText {
  const nameLabel = "Name";
  const namePad = " ".repeat(Math.max(0, widths.nameWidth - nameLabel.length));
  const sizeLabel = "Size".padStart(widths.sizeWidth);
  return t`${" ".repeat(ROW_NAME_OFFSET)}${fg(tokens.textDim)(nameLabel)}${namePad}${" ".repeat(SIZE_GAP)}${fg(tokens.textDim)(sizeLabel)}`;
}

export function buildListRule(widths: RowWidths, tokens: ThemeTokens): StyledText {
  const width = ROW_NAME_OFFSET + widths.nameWidth + SIZE_GAP + widths.sizeWidth;
  return t`${fg(tokens.border)("─".repeat(Math.max(8, width)))}`;
}

export function buildGroupHeaderContent(
  row: Extract<UiDisplayRow, { kind: "header" }>,
  tokens: ThemeTokens,
  widths: RowWidths,
): StyledText {
  const glyph = row.collapsed ? fg(tokens.textDim)("▸") : fg(tokens.accent)("▾");
  const stats = `${row.itemCount} · ${compactBytesLabel(row.bytes)}`;
  const queued = row.selectedCount > 0 ? ` · ${row.selectedCount} queued` : "";
  const total = ROW_NAME_OFFSET + widths.nameWidth + SIZE_GAP + widths.sizeWidth;
  const labelWidth = Math.max(4, total - 2 - stats.length - queued.length - 1);
  const label = truncateScopeLabel(row.label, labelWidth);
  const statsStyled =
    row.selectedCount > 0 ? fg(tokens.positive)(`${stats}${queued}`) : fg(tokens.textDim)(stats);
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
): StyledText {
  const colors = riskColor(tokens);
  const rail = isCurrent ? fg(tokens.accent)("▌") : fg(tokens.textDim)(" ");
  const blocked = candidate.riskTier === "blocked";
  // One status cell carries both facts: shape = queued state, color = risk.
  // ● accent   queued, safe        ● warning  queued, caution
  // ● danger   queued, dangerous   ○ dim/tint unselected (tint = its risk)
  // ⊘          blocked — locked out of queueing entirely
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
  // blocked. Caution is the common case — the trailing glyph carries it, and
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
  const size = formatSizeCell(candidate.estimatedBytes, widths.sizeWidth);
  const sizeColor = isCurrent
    ? tokens.selectionText
    : selected
      ? tokens.positive
      : tokens.textSecondary;
  const nameStyled =
    parentText.length > 0
      ? t`${fg(nameColor)(nameText)}${fg(parentColor)(parentText)}`
      : t`${fg(nameColor)(nameText)}`;

  return joinStyled([
    t`${rail} ${mark} `,
    nameStyled,
    t`${" ".repeat(SIZE_GAP)}${fg(sizeColor)(size)}`,
  ]);
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

function formatSizeCell(bytes: number, width: number): string {
  const label = bytes > 0 ? formatBytes(bytes) : "—";
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
  return ` ${mark} ${pattern}`;
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
  // Under ~44 cols the wordmark collides with the right-side stats — keep the
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
): StyledText {
  const w = width ?? Number.POSITIVE_INFINITY;
  const parts: StyledText[] = [];

  // Under ~100 cols the found count is the first thing to go — the queue is
  // what a destructive keystroke acts on, so it always survives.
  if (w >= 100) {
    parts.push(t`${fg(tokens.textMuted)(`${padCount(summary.visibleCount)} found`)}`);
  }

  if (summary.selectedCount > 0) {
    // The queue outliving the current view is the point — you narrow, queue,
    // narrow again, then apply. Say when part of it is off screen, so a header
    // reading higher than the visible rows is explained rather than alarming.
    const hidden = summary.selectedCount - summary.visibleSelectedCount;
    const queued =
      hidden > 0 && w >= 100
        ? `${padCount(summary.selectedCount)} queued (${summary.visibleSelectedCount} shown)`
        : `${padCount(summary.selectedCount)} queued`;
    parts.push(t`${fg(tokens.accent)(queued)}`);
    if (w >= 84) {
      parts.push(t`${bold(fg(tokens.positive)(formatBytes(summary.selectedBytes)))}`);
    }
  }

  if (dryRun) {
    parts.push(t`${bold(fg(tokens.warning)("DRY RUN"))}`);
  }

  return joinStyled(interleave(parts, t`  ${dim("·")}  `));
}

/** Compact reclaim tally for the statusline tail. */
export function buildRiskTally(summary: SweepUiSummary, tokens: ThemeTokens): StyledText {
  if (summary.selectedCount <= 0) {
    return t`${fg(tokens.textDim)("nothing selected")}`;
  }
  return t`${fg(tokens.positive)(formatBytes(summary.selectedBytes))} ${fg(tokens.textMuted)("reclaimable")}`;
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
  if (state.focus === "patterns") {
    const enabled = activePatterns(state).length;
    const dirty = state.patternsDirty ? fg(tokens.warning)("*") : "";
    return t`${fg(tokens.textMuted)(`${enabled} patterns active`)}  ${dim("·")}  ${fg(tokens.accent)("r")} ${dim("rescan")}${dirty}`;
  }

  const candidate = getCurrentCandidate(state);
  if (!candidate) {
    // Cursor can sit on a group header (mouse click / collapsed view) — the
    // footer then describes the group, not a missing list.
    const row = buildDisplayRows(state)[state.rowIndex];
    if (row?.kind === "header") {
      const queued =
        row.selectedCount > 0
          ? `  ${dim("·")}  ${fg(tokens.positive)(`${row.selectedCount} queued`)}`
          : "";
      return t`${fg(tokens.textMuted)(row.label)}  ${fg(tokens.textDim)(`${row.itemCount} item${row.itemCount === 1 ? "" : "s"} · ${compactBytesLabel(row.bytes)}`)}${queued}  ${fg(tokens.textDim)(row.collapsed ? "· l/space expands" : "· h/space collapses")}`;
    }
    return t`${fg(tokens.textDim)("No matching artifacts.")}`;
  }

  const colors = riskColor(tokens);
  const glyph = fg(colors[candidate.riskTier])(riskGlyph[candidate.riskTier]);
  const kind = fg(tokens.textMuted)(candidate.kind);
  const size = fg(tokens.textSecondary)(formatBytes(candidate.estimatedBytes));
  const path = fg(tokens.textSecondary)(truncateMiddle(candidate.path, 64));
  const flag = candidate.isSymlink
    ? fg(tokens.warning)(" symlink")
    : candidate.reasons.includes("workspace-stub")
      ? fg(tokens.textMuted)(" stub")
      : "";

  return t`${glyph}  ${kind}  ${size}  ${path}${flag}`;
}

/** Which key hints the statusline should show. Modals own the footer too. */
export type FooterContext =
  | { kind: "confirm" }
  | { kind: "help" }
  | { kind: "scanError" }
  | { kind: "pane"; focus: UiFocus };

/**
 * Statusline key hints.
 *
 * Every reachable state names its own keys — including the overlays, which
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

  // Narrow terminals: never clip a hint mid-word — swap to a minimal set.
  // Modal hints are already short enough to survive, so this only rewrites
  // the long pane hint rows.
  if (options.compact && context.kind === "pane") {
    return t`${key("↑↓")} ${hint("move")}${sep}${key("space")} ${hint("queue")}${sep}${key("?")} ${hint("keys")}`;
  }

  if (context.kind === "confirm") {
    return t`${key("y")} ${hint("confirm")}${sep}${key("n")} ${hint("cancel")}${sep}${key("esc")} ${hint("back")}${sep}${key("ctrl-c")} ${hint("quit")}`;
  }

  if (context.kind === "help") {
    return t`${key("?")} ${hint("close")}${sep}${key("esc")} ${hint("close")}${sep}${key("q")} ${hint("quit")}`;
  }

  if (context.kind === "scanError") {
    return t`${key("r")} ${hint("retry")}${sep}${key("esc")} ${hint("dismiss")}${sep}${key("q")} ${hint("quit")}`;
  }

  if (context.focus === "patterns") {
    const rescan = options.patternsDirty ? "rescan*" : "rescan";
    return t`${key("space")} ${hint("toggle")}${sep}${key("p")} ${hint("list")}${sep}${key("r")} ${hint(rescan)}${sep}${key("esc")} ${hint("back")}`;
  }

  if (context.focus === "sidebar") {
    return t`${key("↑↓")} ${hint("move")}${sep}${key("l/h")} ${hint("open/close")}${sep}${key("enter")} ${hint("scope")}${sep}${key("tab")} ${hint("panes")}${sep}${key("?")} ${hint("help")}`;
  }

  if (context.focus === "search") {
    return t`${key("enter")} ${hint("list")}${sep}${key("esc")} ${hint("clear")}${sep}${key("tab")} ${hint("panes")}${sep}${key("ctrl-c")} ${hint("quit")}`;
  }

  return t`${key("↑↓")} ${hint("move")}${sep}${key("space")} ${hint("queue")}${sep}${key("enter")} ${hint(options.dryRun ? "done" : "apply")}${sep}${key("/")} ${hint("filter")}${sep}${key("?")} ${hint("help")}`;
}

/** Statusline mode segment label for the focused panel. */
export function modeLabel(focus: UiFocus, scanning = false): string {
  if (scanning) return "SCANNING";
  switch (focus) {
    case "search":
      return "SEARCH";
    case "sidebar":
      return "SCOPES";
    case "patterns":
      return "PATTERNS";
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
