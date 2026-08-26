import { relative } from "node:path";
import type { RiskTier, ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { bold, dim, fg, StyledText, t } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import type { UiDisplayRow } from "./rows.js";
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

/** Columns consumed before the artifact name: rail + gap + marker + gap. */
export const ROW_NAME_OFFSET = 4;
const SIZE_COLUMN_WIDTH = 9;
const RISK_COLUMN_WIDTH = 1;
const SIZE_GAP = 2;
const GLYPH_GAP = 2;
/** Extra cells reserved so a scrollbar or wide glyph cannot wrap the row. */
const WRAP_SAFETY = 2;

export interface RowWidths {
  nameWidth: number;
  sizeWidth: number;
}

/** Column math shared by rows and the column header so they always align. */
export function artifactRowWidths(listWidth: number): RowWidths {
  const usable = Math.max(24, listWidth - WRAP_SAFETY);
  const tail = SIZE_COLUMN_WIDTH + RISK_COLUMN_WIDTH + SIZE_GAP + GLYPH_GAP;
  return {
    nameWidth: Math.max(12, usable - ROW_NAME_OFFSET - tail),
    sizeWidth: SIZE_COLUMN_WIDTH,
  };
}

export function relativePath(root: string, path: string): string {
  return relative(root, path);
}

export function formatGroupHeaderRow(row: Extract<UiDisplayRow, { kind: "header" }>): string {
  const selected = row.selectedCount > 0 ? ` · ${row.selectedCount} selected` : "";
  return `▸ ${row.label} · ${row.itemCount}${selected}`;
}

export function buildListColumnHeader(widths: RowWidths, tokens: ThemeTokens): StyledText {
  const nameLabel = "NAME";
  const namePad = " ".repeat(Math.max(0, widths.nameWidth - nameLabel.length));
  const sizeLabel = "SIZE".padStart(widths.sizeWidth);
  return t`${" ".repeat(ROW_NAME_OFFSET)}${fg(tokens.textSecondary)(nameLabel)}${namePad}${" ".repeat(SIZE_GAP)}${fg(tokens.textSecondary)(sizeLabel)}${" ".repeat(GLYPH_GAP)}${fg(tokens.textSecondary)("R")}`;
}

export function buildListRule(widths: RowWidths, tokens: ThemeTokens): StyledText {
  const width =
    ROW_NAME_OFFSET +
    widths.nameWidth +
    SIZE_GAP +
    widths.sizeWidth +
    GLYPH_GAP +
    RISK_COLUMN_WIDTH;
  return t`${fg(tokens.border)("─".repeat(Math.max(8, width)))}`;
}

export function buildListLegend(tokens: ThemeTokens): StyledText {
  return t`${fg(tokens.textDim)("● queued")}  ${fg(tokens.textDim)("○ available")}  ${fg(tokens.positive)("✓ safe")}  ${fg(tokens.warning)("! caution")}  ${fg(tokens.danger)("✗ dangerous")}`;
}

export function buildGroupHeaderContent(
  row: Extract<UiDisplayRow, { kind: "header" }>,
  tokens: ThemeTokens,
  maxLabelWidth = 48,
): StyledText {
  const glyph = row.collapsed ? fg(tokens.textDim)("▸") : fg(tokens.accent)("▾");
  const label = truncateEnd(row.label, maxLabelWidth);
  const count = `${row.itemCount}`;
  const base = t`${glyph} ${bold(fg(tokens.textSecondary)(label))}  ${fg(tokens.textDim)(count)}`;
  if (row.selectedCount <= 0) return base;

  return joinStyled([base, t`  ${fg(tokens.positive)(`${row.selectedCount} queued`)}`]);
}

/** Plain-text row layout — canonical spacing for tests and debugging. */
export function formatArtifactRow(
  candidate: ScanCandidate,
  selected: boolean,
  _tokens: ThemeTokens,
): string {
  const widths = artifactRowWidths(80);
  return formatArtifactRowPlain(candidate, selected, false, widths);
}

export function formatArtifactRowPlain(
  candidate: ScanCandidate,
  selected: boolean,
  isCurrent: boolean,
  widths: RowWidths,
): string {
  const mark = selected ? SELECTED_MARK : UNSELECTED_MARK;
  const rail = isCurrent ? "▌" : " ";
  const size = formatSizeCell(candidate.estimatedBytes, widths.sizeWidth);
  const name = truncateEnd(candidate.name, widths.nameWidth);
  const glyph = riskGlyph[candidate.riskTier];
  return `${rail} ${mark} ${name}${" ".repeat(SIZE_GAP)}${size}${" ".repeat(GLYPH_GAP)}${glyph}`;
}

export function buildArtifactRowContent(
  candidate: ScanCandidate,
  selected: boolean,
  isCurrent: boolean,
  widths: RowWidths,
  tokens: ThemeTokens,
): StyledText {
  const colors = riskColor(tokens);
  const tierColor = colors[candidate.riskTier];
  const rail = isCurrent ? fg(tokens.accent)("▌") : fg(tokens.textDim)(" ");
  const mark = selected ? fg(tokens.accent)(SELECTED_MARK) : fg(tokens.textDim)(UNSELECTED_MARK);
  const name = truncateEnd(candidate.name, widths.nameWidth);
  const nameColor = isCurrent
    ? tokens.selectionText
    : candidate.riskTier === "blocked"
      ? tokens.blocked
      : tokens.text;
  const size = formatSizeCell(candidate.estimatedBytes, widths.sizeWidth);
  const sizeColor = isCurrent
    ? tokens.selectionText
    : selected
      ? tokens.positive
      : tokens.textSecondary;
  const glyphColor = isCurrent ? tokens.selectionText : tierColor;

  return t`${rail} ${mark} ${fg(nameColor)(name)}${" ".repeat(SIZE_GAP)}${fg(sizeColor)(size)}${" ".repeat(GLYPH_GAP)}${fg(glyphColor)(riskGlyph[candidate.riskTier])}`;
}

function formatSizeCell(bytes: number, width: number): string {
  const label = bytes > 0 ? formatBytes(bytes) : "—";
  return label.padStart(width);
}

function truncateEnd(value: string, max: number): string {
  if (value.length <= max) return value.padEnd(max);
  return `${value.slice(0, Math.max(1, max - 1))}…`;
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
export function buildBrandLine(tokens: ThemeTokens): StyledText {
  return t`${bold(fg(tokens.accent)("◆ sweep"))}`;
}

/** Right side of the header: found / selected / reclaimable bytes chips. */
export function buildHeaderStats(
  plan: ScanPlan,
  summary: SweepUiSummary,
  tokens: ThemeTokens,
  dryRun?: boolean,
): StyledText {
  const parts: StyledText[] = [
    t`${fg(tokens.textMuted)(`${padCount(summary.visibleCount)} found`)}`,
  ];

  if (summary.selectedCount > 0) {
    parts.push(
      t`${fg(tokens.accent)(`${padCount(summary.selectedCount)} selected`)}`,
      t`${bold(fg(tokens.positive)(formatBytes(summary.selectedBytes)))}`,
    );
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

export function buildHeaderLine(
  plan: ScanPlan,
  summary: SweepUiSummary,
  tokens: ThemeTokens,
  dryRun?: boolean,
): StyledText {
  const target = truncateMiddle(plan.targetDir, 48);
  const brand = t`${bold(fg(tokens.accent)("◆ sweep"))}  ${dim("in")}  ${fg(tokens.textSecondary)(target)}`;
  return joinStyled([brand, t`   `, buildHeaderStats(plan, summary, tokens, dryRun)]);
}

/** Plain caption for the artifacts pane border — focused candidate details. */
export function buildContextCaption(state: SweepUiState): string | undefined {
  if (state.focus === "patterns") {
    const enabled = activePatterns(state).length;
    return state.patternsDirty
      ? ` ${enabled} patterns active · r rescan* `
      : ` ${enabled} patterns active `;
  }

  const candidate = getCurrentCandidate(state);
  if (!candidate) return undefined;

  const flags: string[] = [];
  if (candidate.isSymlink) flags.push("symlink");
  if (candidate.reasons.includes("workspace-stub")) flags.push("stub");
  const flagSuffix = flags.length > 0 ? ` · ${flags.join(", ")}` : "";

  return ` ${candidate.kind} · ${formatBytes(candidate.estimatedBytes)}${flagSuffix} · ${truncateMiddle(candidate.path, 56)} `;
}

export function buildContextLine(state: SweepUiState, tokens: ThemeTokens): StyledText {
  if (state.focus === "patterns") {
    const enabled = activePatterns(state).length;
    const dirty = state.patternsDirty ? fg(tokens.warning)("*") : "";
    return t`${fg(tokens.textMuted)(`${enabled} patterns active`)}  ${dim("·")}  ${fg(tokens.accent)("r")} ${dim("rescan")}${dirty}`;
  }

  const candidate = getCurrentCandidate(state);
  if (!candidate) {
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

export function buildFooterLine(
  focus: UiFocus,
  tokens: ThemeTokens,
  dryRun?: boolean,
  patternsDirty?: boolean,
): StyledText {
  const key = (label: string) => fg(tokens.text)(label);
  const hint = (label: string) => fg(tokens.textMuted)(label);
  const sep = dim(" · ");

  if (focus === "patterns") {
    const rescan = patternsDirty ? "rescan*" : "rescan";
    return t`${key("space")} ${hint("toggle")}${sep}${key("p")} ${hint("list")}${sep}${key("r")} ${hint(rescan)}${sep}${key("esc")} ${hint("back")}`;
  }

  if (focus === "sidebar") {
    return t`${key("j/k")} ${hint("move")}${sep}${key("enter")} ${hint("open")}${sep}${key("h")} ${hint("list")}${sep}${key("?")} ${hint("help")}`;
  }

  if (focus === "search") {
    return t`${key("enter")} ${hint("apply")}${sep}${key("esc")} ${hint("clear + back")}${sep}${key("⇥")} ${hint("panes")}`;
  }

  if (dryRun) {
    return t`${key("space")} ${hint("queue")}${sep}${key("a")} ${hint("all")}${sep}${key("o")} ${hint("sort")}${sep}${key("enter")} ${hint("done")}${sep}${key("?")} ${hint("help")}`;
  }

  return t`${key("↑↓")} ${hint("move")}${sep}${key("space")} ${hint("queue")}${sep}${key("a/s/u")} ${hint("all/safe/clear")}${sep}${key("enter")} ${hint("apply")}${sep}${key("?")} ${hint("help")}`;
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

/** Dense scope row: marker · label · count · bytes (+ queued suffix). */
export function buildSidebarLine(
  label: string,
  count: number,
  bytes: number,
  active: boolean,
  countWidth: number,
  bytesWidth: number,
  tokens: ThemeTokens,
  selectedCount = 0,
  maxLabelWidth = 14,
): StyledText {
  const marker = active ? fg(tokens.accent)("›") : fg(tokens.textDim)(" ");
  const countText = String(count).padStart(countWidth);
  const bytesText = compactBytesLabel(bytes).padStart(bytesWidth);
  const effectiveMax = Math.max(6, maxLabelWidth);
  const labelText =
    label.length > effectiveMax
      ? `${label.slice(0, effectiveMax - 1)}…`
      : label.padEnd(effectiveMax);
  const labelColor = active ? tokens.text : tokens.textSecondary;
  const base = t`${marker} ${active ? bold(fg(labelColor)(labelText)) : fg(labelColor)(labelText)}  ${fg(tokens.textMuted)(countText)}  ${fg(active ? tokens.textSecondary : tokens.textDim)(bytesText)}`;

  if (selectedCount <= 0 || !active) return base;
  return joinStyled([base, t`  ${fg(tokens.positive)(`+${selectedCount}`)}`]);
}

/** @deprecated Use buildSidebarLine with StyledText — plain string kept for tests. */
export function formatSidebarLinePlain(label: string, count: number, active: boolean): string {
  const mark = active ? "›" : "·";
  return `${mark} ${label} ${count}`;
}
