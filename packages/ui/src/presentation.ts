import { relative } from "node:path";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { bold, dim, fg, StyledText, t } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import type { UiDisplayRow } from "./rows.js";
import type { SweepUiState, SweepUiSummary } from "./state.js";
import { getCurrentCandidate } from "./state.js";
import { riskColor, riskMark, theme } from "./theme.js";

function padCount(value: number, width = 2): string {
  return String(value).padStart(width, " ");
}

function formatBytesUi(bytes: number): string {
  if (bytes <= 0) return "0 B";
  return formatBytes(bytes);
}

export function relativePath(root: string, path: string): string {
  return relative(root, path);
}

export function formatGroupHeaderRow(row: Extract<UiDisplayRow, { kind: "header" }>): string {
  const selected = row.selectedCount > 0 ? ` · ${row.selectedCount} selected` : "";
  return `▸ ${row.label} · ${row.itemCount}${selected}`;
}

export function formatArtifactRow(candidate: ScanCandidate, selected: boolean): string {
  const mark = selected ? "◉" : "○";
  const size = formatBytesUi(candidate.estimatedBytes).padStart(7);
  const name =
    candidate.name.length > 24 ? `${candidate.name.slice(0, 23)}…` : candidate.name.padEnd(24);
  return `  ${mark} ${name} ${size}  ${riskMark[candidate.riskTier]}`;
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
  dryRun?: boolean,
): StyledText {
  const visible = padCount(summary.visibleCount);
  const selected = padCount(summary.selectedCount);
  const freed = formatBytesUi(summary.selectedBytes);

  const title = t`${bold(fg(theme.accent)("sweep"))}  ${dim(plan.targetDir)}`;
  const stats = t`${fg(theme.textMuted)(`${visible} visible`)}  ${dim("·")}  ${fg(theme.textSecondary)(`${selected} selected`)}  ${dim("·")}  ${fg(theme.positive)(freed)}`;

  const segments = [title, t`\n`, stats];
  if (dryRun) {
    segments.push(t`  ${fg(theme.warning)("dry run")}`);
  }

  return joinStyled(segments);
}

export function buildContextLine(state: SweepUiState): StyledText {
  const candidate = getCurrentCandidate(state);
  if (!candidate) {
    return t`${fg(theme.textDim)("No matching artifacts.")}`;
  }

  const tier = fg(riskColor[candidate.riskTier])(riskMark[candidate.riskTier]);
  const path = fg(theme.textSecondary)(candidate.path);
  const reasons =
    candidate.reasons.length > 0
      ? fg(theme.textMuted)(`  ·  ${candidate.reasons.slice(0, 2).join(", ")}`)
      : "";

  return t`${tier}  ${path}${reasons}`;
}

export function buildFooterLine(dryRun?: boolean): StyledText {
  const key = (label: string) => fg(theme.accent)(label);
  const hint = (label: string) => fg(theme.textMuted)(label);

  if (dryRun) {
    return t`${key("tab")} ${hint("filter")}  ${key("space")} ${hint("toggle")}  ${key("s")} ${hint("safe")}  ${key("a")} ${hint("all")}  ${key("u")} ${hint("clear")}  ${key("enter")} ${hint("done")}  ${key("esc")} ${hint("quit")}`;
  }

  return t`${key("tab")} ${hint("filter")}  ${key("space")} ${hint("toggle")}  ${key("s")} ${hint("safe")}  ${key("a")} ${hint("all")}  ${key("u")} ${hint("clear")}  ${key("enter")} ${hint("apply")}  ${key("esc")} ${hint("quit")}`;
}
