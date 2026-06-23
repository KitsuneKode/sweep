import { relative } from "node:path";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { bold, dim, fg, StyledText, t } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import type { UiDisplayRow } from "./rows.js";
import type { SweepUiState, SweepUiSummary, UiFocus } from "./state.js";
import { activePatterns, getCurrentCandidate } from "./state.js";
import { type ThemeTokens, riskColor, riskMark } from "./theme.js";

function padCount(value: number, width = 2): string {
  return String(value).padStart(width, " ");
}

function formatBytesUi(bytes: number): string {
  if (bytes <= 0) return "      0 B";
  const formatted = formatBytes(bytes);
  return formatted.padStart(9);
}

export function relativePath(root: string, path: string): string {
  return relative(root, path);
}

export function formatGroupHeaderRow(row: Extract<UiDisplayRow, { kind: "header" }>): string {
  const selected = row.selectedCount > 0 ? ` · ${row.selectedCount} selected` : "";
  return `▸ ${row.label} · ${row.itemCount}${selected}`;
}

export function buildListColumnHeader(tokens: ThemeTokens): StyledText {
  return t`${fg(tokens.textMuted)("     artifact")}  ${fg(tokens.textDim)("      size")}  ${fg(tokens.textDim)("risk")}`;
}

export function buildGroupHeaderContent(
  row: Extract<UiDisplayRow, { kind: "header" }>,
  tokens: ThemeTokens,
): StyledText {
  const base = t`${fg(tokens.accent)("▸")}  ${bold(fg(tokens.textSecondary)(row.label))}  ${dim("·")}  ${fg(tokens.textMuted)(String(row.itemCount))}`;
  if (row.selectedCount <= 0) return base;

  return joinStyled([
    base,
    t`  ${dim("·")}  ${fg(tokens.textMuted)(`${row.selectedCount} selected`)}`,
  ]);
}

export function formatArtifactRow(
  candidate: ScanCandidate,
  selected: boolean,
  _tokens: ThemeTokens,
): string {
  const mark = selected ? "[x]" : "[ ]";
  const size = formatBytesUi(candidate.estimatedBytes);
  const name =
    candidate.name.length > 22 ? `${candidate.name.slice(0, 21)}…` : candidate.name.padEnd(22);
  const tier = riskMark[candidate.riskTier];
  return ` ${mark} ${name} ${size}  ${tier}`;
}

export function buildArtifactRowContent(
  candidate: ScanCandidate,
  selected: boolean,
  isCurrent: boolean,
  tokens: ThemeTokens,
): StyledText {
  const mark = selected ? "[x]" : "[ ]";
  const size = formatBytesUi(candidate.estimatedBytes);
  const name =
    candidate.name.length > 28 ? `${candidate.name.slice(0, 27)}…` : candidate.name.padEnd(28);
  const colors = riskColor(tokens);
  const tierColor = colors[candidate.riskTier];
  const tier = fg(tierColor)(riskMark[candidate.riskTier]);
  const nameColor = isCurrent ? tokens.selectionText : tokens.text;
  const markColor = selected ? tokens.accent : tokens.textMuted;

  return t` ${fg(markColor)(mark)} ${fg(nameColor)(name)} ${fg(tokens.textSecondary)(size)}  ${tier}`;
}

export function formatPatternRow(pattern: string, enabled: boolean): string {
  const mark = enabled ? "[x]" : "[ ]";
  return ` ${mark} ${pattern}`;
}

function joinStyled(segments: StyledText[]): StyledText {
  const chunks: TextChunk[] = [];
  for (const segment of segments) {
    chunks.push(...segment.chunks);
  }
  return new StyledText(chunks);
}

export function buildHeaderLine(
  plan: ScanPlan,
  summary: SweepUiSummary,
  tokens: ThemeTokens,
  dryRun?: boolean,
): StyledText {
  const visible = padCount(summary.visibleCount);
  const selected = padCount(summary.selectedCount);
  const freed = formatBytes(summary.selectedBytes);

  const title = t`${bold(fg(tokens.accent)("sweep"))}  ${dim(plan.targetDir)}`;
  const stats = t`${fg(tokens.textMuted)(`${visible} visible`)}  ${dim("·")}  ${fg(tokens.textSecondary)(`${selected} selected`)}  ${dim("·")}  ${fg(tokens.positive)(freed)}`;

  const segments = [title, t`\n`, stats];
  if (dryRun) {
    segments.push(t`  ${fg(tokens.warning)("dry run")}`);
  }

  return joinStyled(segments);
}

export function buildContextLine(state: SweepUiState, tokens: ThemeTokens): StyledText {
  if (state.focus === "patterns") {
    const enabled = activePatterns(state).length;
    return t`${fg(tokens.textMuted)(`Patterns: ${enabled} active`)}  ${dim("·")}  ${fg(tokens.accent)("r")} ${dim("rescan")}`;
  }

  const candidate = getCurrentCandidate(state);
  if (!candidate) {
    return t`${fg(tokens.textDim)("No matching artifacts.")}`;
  }

  const colors = riskColor(tokens);
  const tier = fg(colors[candidate.riskTier])(riskMark[candidate.riskTier]);
  const kind = fg(tokens.textMuted)(candidate.kind);
  const path = fg(tokens.textSecondary)(candidate.path);
  const symlink = candidate.isSymlink ? fg(tokens.warning)(" symlink") : "";
  const stub = candidate.reasons.includes("workspace-stub") ? fg(tokens.textMuted)(" stub") : "";
  const reasons =
    candidate.reasons.length > 0
      ? fg(tokens.textMuted)(`  ·  ${candidate.reasons.slice(0, 2).join(", ")}`)
      : "";

  return t`${tier}  ${kind}  ${path}${symlink}${stub}${reasons}`;
}

export function buildFooterLine(
  focus: UiFocus,
  tokens: ThemeTokens,
  dryRun?: boolean,
  patternsDirty?: boolean,
): StyledText {
  const key = (label: string) => fg(tokens.accent)(label);
  const hint = (label: string) => fg(tokens.textMuted)(label);

  if (focus === "patterns") {
    const rescan = patternsDirty
      ? `  ${key("r")} ${hint("rescan*")}`
      : `  ${key("r")} ${hint("rescan")}`;
    return t`${key("space")} ${hint("toggle")}  ${key("p")} ${hint("list")}${rescan}  ${key("esc")} ${hint("quit")}`;
  }

  if (focus === "sidebar") {
    return t`${key("enter")} ${hint("filter scope")}  ${key("p")} ${hint("patterns")}  ${key("/")} ${hint("search")}  ${key("esc")} ${hint("quit")}`;
  }

  if (dryRun) {
    return t`${key("tab")} ${hint("panels")}  ${key("space")} ${hint("toggle")}  ${key("s")} ${hint("safe")}  ${key("a")} ${hint("all")}  ${key("u")} ${hint("clear")}  ${key("enter")} ${hint("done")}  ${key("t")} ${hint("theme")}`;
  }

  return t`${key("tab")} ${hint("panels")}  ${key("space")} ${hint("toggle")}  ${key("s")} ${hint("safe")}  ${key("a")} ${hint("all")}  ${key("p")} ${hint("patterns")}  ${key("r")} ${hint("rescan")}  ${key("enter")} ${hint("apply")}  ${key("?")} ${hint("help")}  ${key("t")} ${hint("theme")}`;
}

export function buildSidebarLine(
  label: string,
  count: number,
  active: boolean,
  countWidth: number,
  tokens: ThemeTokens,
): StyledText {
  const marker = active ? "›" : "·";
  const markerColor = active ? tokens.accent : tokens.textMuted;
  const countText = String(count).padStart(countWidth);
  const labelText = label.length > 18 ? `${label.slice(0, 17)}…` : label;

  return t`${fg(markerColor)(marker)}  ${fg(active ? tokens.text : tokens.textSecondary)(labelText)}  ${fg(tokens.textMuted)(countText)}`;
}

/** @deprecated Use buildSidebarLine with StyledText — plain string kept for tests. */
export function formatSidebarLinePlain(label: string, count: number, active: boolean): string {
  const mark = active ? "›" : "·";
  return `${mark} ${label} ${count}`;
}
