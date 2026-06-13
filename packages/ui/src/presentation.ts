import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { bold, dim, fg, StyledText, t } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import type { SweepUiState, SweepUiSummary } from "./state.js";
import { getCurrentCandidate, getVisibleCandidates } from "./state.js";
import { riskColor, riskGlyph, riskTag, theme } from "./theme.js";

/** Fixed-width integers so stat columns do not jitter while navigating. */
function padCount(value: number, width = 3): string {
  return String(value).padStart(width, " ");
}

function formatBytesUi(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const formatted = formatBytes(bytes);
  return formatted === "~" ? "0 B" : formatted;
}

function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  const head = Math.max(8, Math.floor(maxLen * 0.35));
  const tail = maxLen - head - 1;
  return `${path.slice(0, head)}…${path.slice(-tail)}`;
}

export function formatListOptionName(candidate: ScanCandidate, selected: boolean): string {
  const mark = selected ? "◉" : "○";
  const glyph = riskGlyph[candidate.riskTier];
  const tag = riskTag[candidate.riskTier];
  return `${mark} ${glyph} ${tag.padEnd(8)} ${candidate.name}`;
}

export function formatListOptionDescription(candidate: ScanCandidate): string {
  const size = formatBytesUi(candidate.estimatedBytes).padStart(8);
  const kind = candidate.kind.padEnd(14);
  const path = truncatePath(candidate.path, 72);
  return `${kind} ${size}  ${path}`;
}

function joinStyled(segments: StyledText[]): StyledText {
  const chunks: TextChunk[] = [];
  for (const segment of segments) {
    chunks.push(...segment.chunks);
  }
  return new StyledText(chunks);
}

function segmentDivider(): StyledText {
  return t`  ${dim("│")}  `;
}

export function buildTitleLine(dryRun?: boolean): StyledText {
  if (dryRun) {
    return t`${bold(fg(theme.accent)("SWEEP"))}  ${dim("artifact picker")}  ${fg(theme.warning)("DRY RUN")}`;
  }
  return t`${bold(fg(theme.accent)("SWEEP"))}  ${dim("artifact picker")}`;
}

export function buildStatsLine(summary: SweepUiSummary, state: SweepUiState): StyledText {
  const visible = padCount(summary.visibleCount);
  const selected = padCount(summary.selectedCount);
  const freed = formatBytesUi(summary.selectedBytes).padStart(8);

  const segments: StyledText[] = [
    t`${fg(theme.textMuted)("visible")} ${fg(theme.info)(visible)}`,
    t`${fg(theme.textMuted)("selected")} ${fg(theme.accentBright)(selected)}`,
    t`${fg(theme.textMuted)("to free")} ${fg(theme.positive)(freed)}`,
  ];

  if (summary.dangerousVisibleCount > 0) {
    segments.push(
      t`${fg(theme.danger)("▲")} ${fg(theme.danger)(padCount(summary.dangerousVisibleCount))} ${fg(theme.textMuted)("dangerous visible")}`,
    );
  }

  const selectedDangerous = countSelectedRisk(state, "dangerous");
  if (selectedDangerous > 0) {
    segments.push(
      t`${fg(theme.warning)("!")} ${fg(theme.warning)(padCount(selectedDangerous))} ${fg(theme.textMuted)("dangerous selected")}`,
    );
  }

  const joined: StyledText[] = [];
  for (let index = 0; index < segments.length; index++) {
    if (index > 0) joined.push(segmentDivider());
    joined.push(segments[index]!);
  }

  return joinStyled(joined);
}

export function buildTargetLine(plan: ScanPlan): StyledText {
  return t`${fg(theme.textDim)("target")}  ${fg(theme.text)(plan.targetDir)}`;
}

export function buildDetailLine(state: SweepUiState): StyledText {
  const candidate = getCurrentCandidate(state);
  if (!candidate) {
    return t`${fg(theme.textDim)("No artifacts match the current filter.")}`;
  }

  const selected = state.selectedIds.has(candidate.id);
  const mark = selected
    ? fg(theme.checkboxOn)("◉ selected")
    : fg(theme.checkboxOff)("○ not selected");
  const tier = fg(riskColor[candidate.riskTier])(
    `${riskGlyph[candidate.riskTier]} ${riskTag[candidate.riskTier]}`,
  );
  const kind = fg(theme.info)(candidate.kind);
  const size = fg(theme.positive)(formatBytesUi(candidate.estimatedBytes));
  const path = fg(theme.text)(candidate.path);
  const reasons =
    candidate.reasons.length > 0
      ? fg(theme.textMuted)(`  ·  ${candidate.reasons.slice(0, 2).join(", ")}`)
      : "";

  return t`${mark}  ${tier}  ${kind}  ${size}  ${path}${reasons}`;
}

export function buildFooterLine(dryRun?: boolean): StyledText {
  const key = (label: string) => fg(theme.accent)(label);
  const hint = (label: string) => fg(theme.textMuted)(label);

  if (dryRun) {
    return t`${key("Tab")} ${hint("focus")}  ${key("Space")} ${hint("toggle")}  ${key("s")} ${hint("safe")}  ${key("a")} ${hint("all")}  ${key("u")} ${hint("clear")}  ${key("Enter")} ${hint("finish")}  ${key("Esc")} ${hint("quit")}  ${fg(theme.warning)("dry run — no delete")}`;
  }

  return t`${key("Tab")} ${hint("focus")}  ${key("Space")} ${hint("toggle")}  ${key("s")} ${hint("safe")}  ${key("a")} ${hint("all")}  ${key("u")} ${hint("clear")}  ${key("Enter")} ${hint("apply")}  ${key("Esc")} ${hint("quit")}`;
}

function countSelectedRisk(state: SweepUiState, tier: ScanCandidate["riskTier"]): number {
  let count = 0;
  for (const candidate of getVisibleCandidates(state)) {
    if (candidate.riskTier === tier && state.selectedIds.has(candidate.id)) {
      count++;
    }
  }
  return count;
}
