import type { RiskTier, ScanCandidate, ScanPlan, StatusSummary } from "@kitsunekode/sweep-protocol";
import { sanitizeMultilineTerminalText, sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes, formatScanElapsed } from "./bytes.js";
import { groupCandidatesByKind } from "./grouping.js";
import { costDot, createPalette, formatRelativeTime, plural, type Palette } from "./palette.js";
import { displayTarget, printScanReport, truncateMiddle } from "./report.js";
import { formatRiskBadge } from "./risk.js";

export interface PrintGroupedScanPlanOptions {
  verbose?: boolean;
  /** Wall-clock scan time - printed in the header when provided. */
  elapsedMs?: number;
  /** Backend that produced the plan - printed in the header when provided. */
  engine?: string;
  /** The run's --idle window, for the report's headline. */
  idleMs?: number;
}

const WORKSPACE_STUB_REASON = "workspace-stub";
const SYMLINK_ALIAS_REASON = "symlink-alias";
const CLOUD_SYNC_REASON = "cloud-sync";

export { formatBytes, formatScanElapsed } from "./bytes.js";
export { createSpinner, type Spinner } from "./spinner.js";
export {
  displayPath,
  displayTarget,
  formatScanReport,
  idleLabel,
  printScanReport,
  truncateMiddle,
  type ScanReportOptions,
} from "./report.js";
export {
  formatDoctorReport,
  printDoctorReport,
  type DoctorCheckEntry,
  type DoctorCheckStatus,
  type DoctorReportOptions,
} from "./doctor.js";
export {
  costCategoryForKind,
  costDot,
  createPalette,
  formatRelativeTime,
  plural,
  resolveColorDepth,
  type ColorDepth,
  type CostCategory,
  type Palette,
  type PaletteOptions,
} from "./palette.js";
export { formatRiskBadge, riskBadgeLabel, type RiskBadgeLabel } from "./risk.js";
export {
  groupCandidatesByKind,
  groupScanEntries,
  type CandidateGroup,
  type ScanResultGroup,
} from "./grouping.js";
export {
  clearDeletionProgress,
  formatDeletionProgress,
  formatDeletionStatus,
  printDeletionProgress,
} from "./deletion.js";
export {
  createProgressiveScanRenderer,
  type ProgressiveScanRenderer,
  type ProgressiveScanSummary,
} from "./progressive.js";
export {
  formatInitDryRunJson,
  formatInitNextSteps,
  formatInitReport,
  printInitDryRunJson,
  printInitNextSteps,
  printInitReport,
  type InitDisplayOptions,
  type InitFinding,
  type InitReport,
} from "./init.js";
export { sanitizeTerminalText, sanitizeMultilineTerminalText } from "@kitsunekode/sweep-protocol";

function isTTY(): boolean {
  return process.stdout.isTTY === true;
}

function sumBytes(candidates: ScanCandidate[], selectedIds: Set<string>): number {
  return candidates
    .filter((candidate) => selectedIds.has(candidate.id))
    .reduce((sum, candidate) => sum + candidate.estimatedBytes, 0);
}

// ─── Output sections ──────────────────────────────────────────────────────────

export function printBanner(): void {
  if (!isTTY()) return;
  const palette = createPalette();
  console.log(
    `\n ${palette.bold(palette.accent("◆ sweep"))} ${palette.dim("·")} ${palette.dim("artifact cleanup")}\n`,
  );
}

export function printGroupedScanPlan(
  plan: ScanPlan,
  targetDir: string,
  options: PrintGroupedScanPlanOptions = {},
): void {
  if (isTTY()) {
    printScanReport(plan, targetDir, options);
    return;
  }
  const palette = createPalette();
  const verbose = options.verbose ?? false;
  const selectedIds = new Set(plan.selectedCandidateIds);

  const skipped =
    plan.summary.skippedDirs && plan.summary.skippedDirs > 0
      ? ` (${plan.summary.skippedDirs} skipped)`
      : "";
  // Paths come off disk - escape control characters before they reach the
  // terminal or a hostile directory name becomes an ANSI injection vector.
  const shownTarget = sanitizeTerminalText(targetDir);
  const elapsed =
    options.elapsedMs !== undefined ? ` · ${formatScanElapsed(options.elapsedMs)}` : "";
  const engine = options.engine ? ` · ${options.engine}` : "";
  const header = `scanned ${plural(plan.summary.scannedDirs, "dir")}${skipped} in ${shownTarget}${elapsed}${engine}`;
  console.log(`sweep: ${header}`);

  if (plan.candidates.length === 0) {
    console.log("sweep: nothing to clean.");
    return;
  }

  const hiddenStubs = verbose
    ? []
    : plan.candidates.filter((candidate) => isWorkspaceStub(candidate));
  const visibleCandidates = verbose
    ? plan.candidates
    : plan.candidates.filter((candidate) => !isWorkspaceStub(candidate));

  printPlainGroupedCandidates(
    groupCandidatesByKind(visibleCandidates),
    plan.summary.exact,
    selectedIds,
    palette,
  );

  printPlainScanTotals(plan, selectedIds, hiddenStubs.length, verbose);
}

function isWorkspaceStub(candidate: ScanCandidate): boolean {
  return candidate.reasons.includes(WORKSPACE_STUB_REASON);
}

function insightBadge(candidate: ScanCandidate, palette: Palette): string {
  const parts: string[] = [];
  if (candidate.reasons.includes(WORKSPACE_STUB_REASON)) parts.push("workspace stub");
  else if (candidate.reasons.includes(SYMLINK_ALIAS_REASON)) parts.push("symlink alias");
  else if (candidate.isSymlink) parts.push("symlink");
  if (candidate.reasons.includes(CLOUD_SYNC_REASON)) parts.push("cloud-synced");
  return parts.length > 0 ? palette.dim(` ${parts.join(" · ")}`) : "";
}

function printPlainScanTotals(
  plan: ScanPlan,
  selectedIds: Set<string>,
  hiddenStubCount: number,
  verbose: boolean,
): void {
  const exact = plan.summary.exact;
  const sizePrefix = exact ? "" : "~";
  const totalLabel = exact ? "measured" : "estimated";
  const selectedBytes = sumBytes(plan.candidates, selectedIds);
  const partialNote = plan.summary.uniqueBytesPartial
    ? " · shared hardlinks not fully counted"
    : "";
  console.log(
    `sweep: ${plan.selectedCandidateIds.length} selected, ${plan.candidates.length} found (${sizePrefix}${formatBytes(selectedBytes)} ${totalLabel} selected size${partialNote})`,
  );
  if (hiddenStubCount > 0 && !verbose) {
    console.log(
      `sweep: ${hiddenStubCount} workspace node_modules ${hiddenStubCount === 1 ? "stub" : "stubs"} hidden`,
    );
  }
}

function printPlainGroupedCandidates(
  groups: ReturnType<typeof groupCandidatesByKind>,
  exact: boolean,
  selectedIds: Set<string>,
  palette: Palette,
): void {
  const sizePrefix = exact ? "" : "~";

  for (const group of groups) {
    console.log(
      `sweep: group ${group.label} (${group.entries.length}) ${sizePrefix}${formatBytes(group.totalBytes)}`,
    );

    for (const entry of group.entries) {
      // A partially-sized subtree undercounts - mark the row so a missing
      // unreadable chunk never reads as the real freed-bytes figure.
      const size = `${entry.bytesKnown === false ? "~" : ""}${formatBytes(entry.estimatedBytes)}`;
      const selected = selectedIds.has(entry.id);
      const badge = ` ${formatRiskBadge(entry.riskTier, palette)}`;
      const note = insightBadge(entry, palette);
      console.log(
        `sweep: ${selected ? "selected" : "found"} ${sanitizeTerminalText(entry.name)} (${sanitizeTerminalText(entry.path)}) ${sizePrefix}${size}${badge}${note}`,
      );
    }

    console.log();
  }
}

export function printDryRunNotice(): void {
  if (!isTTY()) {
    console.log("  Dry run. No files deleted.");
    console.log();
    return;
  }
  const palette = createPalette();
  console.log(` ${palette.dim("Dry run · nothing was deleted.")}`);
  console.log(
    `   ${palette.accent("sweep")}      ${palette.dim("clean what is selected, after one confirmation")}`,
  );
  console.log(`   ${palette.accent("sweep ui")}   ${palette.dim("choose item by item")}`);
  console.log();
}

export function printCleanResult(
  result: import("@kitsunekode/sweep-protocol").CleanResult,
  options: {
    trashDir?: string;
    outcomes?: import("@kitsunekode/sweep-protocol").ApplyOutcome[];
  } = {},
): void {
  // Use the observable stream, including under Bun, so a lost final apply
  // receipt cannot bypass the CLI's EPIPE handler and delivery barrier.
  const print = (line = "") => process.stdout.write(`${line}\n`);
  const palette = createPalette();
  const duration =
    result.durationMs < 1000
      ? `${result.durationMs}ms`
      : `${(result.durationMs / 1000).toFixed(1)}s`;
  const verb = options.trashDir ? "Moved" : "Cleaned";

  if (process.stdout.isTTY) {
    print(
      `${palette.positive("✓")} ${verb} ${palette.bold(plural(result.deleted.length, "item"))}, ` +
        `~${palette.bold(palette.positive(formatBytes(result.totalBytesFreed)))} estimated bytes ${options.trashDir ? "moved" : "removed"} ` +
        palette.dim(`(${duration})`),
    );
  } else {
    print(
      `sweep: done, ~${formatBytes(result.totalBytesFreed)} estimated bytes ${options.trashDir ? "moved" : "removed"} in ${duration}`,
    );
  }

  const covered = options.outcomes?.filter((outcome) => outcome.status === "covered").length ?? 0;
  const unattempted =
    options.outcomes?.filter((outcome) => outcome.status === "unattempted").length ?? 0;
  if (covered) {
    print(
      palette.dim(
        `  ${plural(covered, "nested or duplicate selection")} covered by completed operations.`,
      ),
    );
  }
  if (unattempted) {
    print(palette.warning(`  ${plural(unattempted, "selection")} not attempted.`));
  }

  if (options.trashDir) {
    print(
      palette.dim(
        `  restore: entries moved to ${sanitizeTerminalText(options.trashDir)}: ` +
          `delete that directory to reclaim the space.`,
      ),
    );
  }

  if (result.failedPaths.length > 0) {
    print();
    print(
      palette.warning(
        `${process.stdout.isTTY ? "!" : "warning:"} ${plural(result.failedPaths.length, "item")} failed to delete:`,
      ),
    );
    for (const { path, error } of result.failedPaths) {
      print(
        `  ${palette.dim(sanitizeTerminalText(path))}: ${palette.danger(sanitizeTerminalText(error))}`,
      );
    }
  }
}

export function printAborted(): void {
  const palette = createPalette();
  console.log(palette.dim("Aborted."));
}

/** Deletion was interrupted (SIGINT) - some entries were removed, the rest untouched. */
export function printInterrupted(
  deleted: number,
  total: number,
  options: { verb?: string } = {},
): void {
  const palette = createPalette();
  const prefix = process.stdout.isTTY ? "!" : "warning:";
  process.stdout.write("\n");
  process.stdout.write(
    palette.warning(
      `${prefix} Interrupted: ${deleted} of ${plural(total, "item")} ${options.verb ?? "deleted"}. ` +
        `The rest were left in place.`,
    ) + "\n",
  );
}

/** Neutral message shown when the user declines a confirmation prompt. */
export function printDeclined(): void {
  const palette = createPalette();
  console.log(palette.dim("Declined. Nothing deleted."));
}

export interface PlanInfoSummary {
  protocolVersion: string;
  createdAt: string;
  targetDir: string;
  /**
   * Canonical resolution of targetDir, when the path still resolves. Shown
   * when it differs - a spelled path through symlinks must not hide where
   * apply will actually operate.
   */
  resolvedTargetDir?: string;
  candidateCount: number;
  selectedCount: number;
  selectedBytes: number;
  estimatedTotalBytes: number;
  scannedDirs: number;
  skippedDirs: number;
  exact: boolean;
  kinds: Record<string, number>;
  risks: Record<string, number>;
}

export interface PlanInfoFormatOptions {
  tty?: boolean;
  columns?: number;
  now?: number;
  palette?: Palette;
}

const RISK_ORDER: readonly RiskTier[] = ["safe", "caution", "dangerous", "blocked"];

function formatPlanRiskBadges(
  risks: Record<string, number>,
  tty: boolean,
  palette: Palette,
): string {
  const ordered = [
    ...RISK_ORDER.filter((tier) => (risks[tier] ?? 0) > 0).map(
      (tier) => [tier, risks[tier]!] as const,
    ),
    ...Object.entries(risks).filter(([tier, n]) => n > 0 && !RISK_ORDER.includes(tier as RiskTier)),
  ];
  if (ordered.length === 0) return palette.dim("none");
  const parts = ordered.map(([tier, count]) => {
    if (!tty) return `${count} ${tier}`;
    if (tier === "safe") return palette.positive(`✓ ${count} safe`);
    if (tier === "caution") return palette.warning(`! ${count} caution`);
    if (tier === "dangerous") return palette.danger(`✗ ${count} dangerous`);
    if (tier === "blocked") return palette.dim(`⊘ ${count} blocked`);
    return `${count} ${tier}`;
  });
  return parts.join(tty ? palette.dim("  ·  ") : ", ");
}

/** Format `sweep inspect --plan` output (pure, testable). */
export function formatPlanInfo(
  planPath: string,
  summary: PlanInfoSummary,
  options: PlanInfoFormatOptions = {},
): string[] {
  const tty = options.tty ?? process.stdout.isTTY === true;
  const palette = options.palette ?? createPalette({ stream: { isTTY: tty } });
  const columns = Math.max(56, Math.min(options.columns ?? process.stdout.columns ?? 100, 120));
  const now = options.now ?? Date.now();
  const safePlan = sanitizeTerminalText(planPath);
  const safeTarget = sanitizeTerminalText(summary.targetDir);
  const labelWidth = 14;
  const valueBudget = Math.max(24, columns - (2 + labelWidth));
  const field = (label: string, value: string) =>
    `  ${palette.dim(label.padEnd(labelWidth))}${value}`;
  const lines: string[] = [];

  if (tty) {
    lines.push("");
    const planDisplay = truncateMiddle(displayTarget(safePlan), Math.max(16, columns - 19));
    lines.push(
      ` ${palette.bold(palette.accent("◆ sweep inspect"))} ${palette.dim("·")} ${planDisplay}`,
    );
    lines.push("");
  } else {
    lines.push(`plan          ${safePlan}`);
  }

  lines.push(
    field("target", tty ? truncateMiddle(displayTarget(safeTarget), valueBudget) : safeTarget),
  );
  if (summary.resolvedTargetDir !== undefined && summary.resolvedTargetDir !== summary.targetDir) {
    const safeResolved = sanitizeTerminalText(summary.resolvedTargetDir);
    lines.push(
      field(
        "resolves to",
        tty ? truncateMiddle(displayTarget(safeResolved), valueBudget) : safeResolved,
      ),
    );
  }

  const relative = formatRelativeTime(summary.createdAt, now);
  const safeCreated = sanitizeTerminalText(summary.createdAt);
  lines.push(
    field("created", tty && relative ? `${relative}  ${palette.dim(safeCreated)}` : safeCreated),
  );
  lines.push(field("protocol", `v${sanitizeTerminalText(summary.protocolVersion)}`));

  const kindEntries = Object.entries(summary.kinds).sort((a, b) => b[1] - a[1]);
  const kindList =
    kindEntries.length > 0
      ? kindEntries
          .map(([kind, n]) =>
            tty
              ? `${costDot(kind, palette)} ${n} ${sanitizeTerminalText(kind)}`
              : `${n} ${sanitizeTerminalText(kind)}`,
          )
          .join(tty ? palette.dim("  ·  ") : ", ")
      : "";
  lines.push(
    field(
      "candidates",
      `${palette.bold(String(summary.candidateCount))}` +
        (kindList ? (tty ? `  ${kindList}` : ` (${kindList})`) : ""),
    ),
  );

  lines.push(field("risk", formatPlanRiskBadges(summary.risks, tty, palette)));

  const approxPrefix = summary.exact ? "" : "~";
  lines.push(
    field(
      "selected",
      `${plural(summary.selectedCount, "item")}${palette.dim(" · ")}${palette.bold(palette.positive(`${approxPrefix}${formatBytes(summary.selectedBytes)}`))}`,
    ),
  );

  lines.push(
    field(
      "scanned",
      `${plural(summary.scannedDirs, "dir")}${palette.dim(" · ")}~${formatBytes(summary.estimatedTotalBytes)}` +
        (summary.skippedDirs > 0
          ? palette.warning(` · ${summary.skippedDirs} skipped (unreadable)`)
          : ""),
    ),
  );
  lines.push(field("exact sizes", summary.exact ? palette.positive("yes") : palette.dim("no")));

  lines.push("");
  lines.push(
    tty
      ? `  ${palette.dim("apply with")}  ${palette.accent(`sweep apply --plan ${safePlan}`)}`
      : `  apply with: sweep apply --plan ${safePlan}`,
  );
  if (tty) lines.push("");
  return lines;
}

/** `sweep inspect` - provenance + totals for a saved plan, no apply. */
export function printPlanInfo(
  planPath: string,
  summary: PlanInfoSummary,
  options: PlanInfoFormatOptions = {},
): void {
  for (const line of formatPlanInfo(planPath, summary, options)) {
    console.log(line);
  }
}

export interface StatsSession {
  ts: string;
  targetDir: string;
  deleted: number;
  bytesFreed: number;
  failed: number;
  interrupted: boolean;
  trashDir?: string;
}

export interface StatsTotals {
  sessions: number;
  totalDeleted: number;
  totalBytesFreed: number;
  totalFailed: number;
}

export interface StatusFormatOptions {
  tty?: boolean;
  columns?: number;
  palette?: Palette;
}

function formatStatusProjectDuration(project: { idleDays: number; idleMs: number }): string {
  if (project.idleMs < 60_000) return "active now";
  if (project.idleMs < 3_600_000) {
    return plural(Math.floor(project.idleMs / 60_000), "minute");
  }
  if (project.idleMs < 86_400_000) {
    return plural(Math.floor(project.idleMs / 3_600_000), "hour");
  }
  return plural(project.idleDays, "day");
}

function formatStatusWorktreeTag(project: {
  worktreeOf?: string;
  worktreeState?: "merged" | "upstream_gone";
}): string {
  if (project.worktreeOf === undefined) return "";
  const repo = sanitizeTerminalText(
    project.worktreeOf
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || project.worktreeOf,
  );
  const state =
    project.worktreeState === "merged"
      ? "merged"
      : project.worktreeState === "upstream_gone"
        ? "branch missing"
        : "worktree";
  return ` (${repo} · ${state})`;
}

function formatStatusCoverageNote(
  status: StatusSummary,
  tty: boolean,
  palette: Palette,
): string | null {
  if (status.complete) return null;
  const parts: string[] = [];
  if (status.skippedDirs > 0) {
    parts.push(`${plural(status.skippedDirs, "folder")} could not be read`);
  }
  if (status.bytesPartial) {
    parts.push(`${plural(status.partialByteCount, "item")} partially sized`);
  }
  if (parts.length === 0) return null;
  const prefix = tty ? `${palette.warning("!")} ` : "";
  return `  ${prefix}${palette.warning(`incomplete scan: ${parts.join(" · ")}`)}`;
}

/** Format `sweep status` output with one shared column layout across sections. */
export function formatStatusSummary(
  status: StatusSummary,
  options: StatusFormatOptions = {},
): string[] {
  const tty = options.tty ?? process.stdout.isTTY === true;
  const palette = options.palette ?? createPalette({ stream: { isTTY: tty } });
  const columns = Math.max(56, Math.min(options.columns ?? process.stdout.columns ?? 100, 120));
  const lines: string[] = [];

  if (tty) {
    lines.push("");
    const shownTarget = sanitizeTerminalText(displayTarget(status.targetDir));
    lines.push(
      ` ${palette.bold(palette.accent("◆ sweep status"))} ${palette.dim("·")} ${truncateMiddle(shownTarget, Math.max(16, columns - 18))}`,
    );
    lines.push("");
  }

  const hasReclaimable = status.reclaimableBytes > 0 || status.kinds.length > 0;
  if (!hasReclaimable) {
    if (status.protectedCount > 0) {
      lines.push(palette.dim("  Nothing automatically reclaimable here."));
      const bytesNote = status.protectedBytes > 0 ? ` (${formatBytes(status.protectedBytes)})` : "";
      lines.push(
        palette.dim(
          `  ${plural(status.protectedCount, "guarded item")} found${bytesNote}, never counted as space to free`,
        ),
      );
    } else {
      lines.push(palette.dim("  Nothing to free here."));
    }
    const coverage = formatStatusCoverageNote(status, tty, palette);
    if (coverage) lines.push(coverage);
    if (tty) lines.push("");
    return lines;
  }

  const headlineParts: string[] = [];
  if (status.finishedWorktrees.projects > 0) {
    headlineParts.push(
      `${formatBytes(status.finishedWorktrees.bytes)} in ${plural(status.finishedWorktrees.projects, "finished worktree")}`,
    );
  }
  if (status.idle.projects > 0) {
    headlineParts.push(
      `${formatBytes(status.idle.bytes)} in ${plural(status.idle.projects, "project")} idle ${status.idle.windowLabel}`,
    );
  }
  const suffix = headlineParts.length > 0 ? palette.dim(` · ${headlineParts.join(" · ")}`) : "";
  const totalSize = `${status.bytesPartial ? "~" : ""}${formatBytes(status.reclaimableBytes)}`;
  const uniqueBytesPartial = status.uniqueBytesPartial === true;
  const hasSharedHardlinks =
    !uniqueBytesPartial &&
    status.uniqueReclaimableBytes !== undefined &&
    status.uniqueReclaimableBytes < status.reclaimableBytes;
  if (hasSharedHardlinks) {
    lines.push(
      `  ${palette.bold(palette.positive(`about ${formatBytes(status.uniqueReclaimableBytes!)} freed`))} ` +
        palette.dim(`(${totalSize} apparent · shared hardlinks)`) +
        suffix,
    );
  } else if (uniqueBytesPartial) {
    lines.push(
      `  ${palette.bold(palette.positive(totalSize))} ${palette.bold("you could free")} ` +
        palette.dim("(apparent · shared hardlinks not fully counted)") +
        suffix,
    );
  } else {
    lines.push(
      `  ${palette.bold(palette.positive(totalSize))} ${palette.bold("you could free")}${suffix}`,
    );
  }

  if (status.protectedCount > 0) {
    const bytesNote = status.protectedBytes > 0 ? ` (${formatBytes(status.protectedBytes)})` : "";
    lines.push(
      palette.dim(
        `  ${plural(status.protectedCount, "guarded item")} found${bytesNote}, never counted as space to free`,
      ),
    );
  }
  if (status.branchMissingWorktrees.projects > 0) {
    const prefix = tty ? `${palette.warning("!")} ` : "";
    lines.push(
      `  ${prefix}${palette.warning(
        `${plural(status.branchMissingWorktrees.projects, "worktree")} with tracking branch missing (${formatBytes(status.branchMissingWorktrees.bytes)}) · check git`,
      )}`,
    );
  }
  const coverage = formatStatusCoverageNote(status, tty, palette);
  if (coverage) lines.push(coverage);

  // Compute one shared label width and size width across kinds, finished
  // worktrees, and idle projects so sizes align vertically down the page.
  const dotPrefixWidth = tty ? 2 : 0;
  const finishedLabels = status.finishedWorktrees.items.map(
    (project) => `${sanitizeTerminalText(project.name)}${formatStatusWorktreeTag(project)}`,
  );
  const idleLabels = status.projects.map(
    (project) => `${sanitizeTerminalText(project.name)}${formatStatusWorktreeTag(project)}`,
  );
  const kindLengths = status.kinds.map(
    (entry) => dotPrefixWidth + sanitizeTerminalText(entry.kind).length,
  );
  const allSizes = [
    ...status.kinds.map((entry) => formatBytes(entry.bytes).length),
    ...status.finishedWorktrees.items.map((project) => formatBytes(project.bytes).length),
    ...status.projects.map((project) => formatBytes(project.bytes).length),
  ];
  const sizeWidth = Math.max(9, ...allSizes);
  const maxLabelBudget = Math.max(18, columns - 2 - 2 - sizeWidth - 2 - 14);
  const labelWidth = Math.min(
    maxLabelBudget,
    Math.max(
      14,
      ...kindLengths,
      ...finishedLabels.map((label) => label.length),
      ...idleLabels.map((label) => label.length),
    ),
  );

  lines.push("");
  for (const entry of status.kinds) {
    const kindName = truncateMiddle(
      sanitizeTerminalText(entry.kind),
      Math.max(8, labelWidth - dotPrefixWidth),
    );
    const padded = kindName.padEnd(Math.max(0, labelWidth - dotPrefixWidth));
    const lead = tty ? `${costDot(entry.kind, palette)} ${padded}` : padded;
    lines.push(
      `  ${lead}  ${formatBytes(entry.bytes).padStart(sizeWidth)}  ${palette.dim(
        plural(entry.count, "item"),
      )}`,
    );
  }

  const pushProjectSection = (
    title: string,
    projects: StatusSummary["projects"],
    labels: string[],
  ) => {
    lines.push("");
    lines.push(`  ${palette.dim(title)}`);
    for (const [index, project] of projects.entries()) {
      const label = truncateMiddle(labels[index]!, labelWidth).padEnd(labelWidth);
      lines.push(
        `  ${label}  ${formatBytes(project.bytes).padStart(sizeWidth)}  ${palette.dim(
          formatStatusProjectDuration(project),
        )}`,
      );
    }
  };

  if (status.finishedWorktrees.items.length > 0) {
    pushProjectSection("Finished worktrees", status.finishedWorktrees.items, finishedLabels);
  }
  if (status.projects.length > 0) {
    pushProjectSection(`Idle ${status.idle.windowLabel}`, status.projects, idleLabels);
  }
  if (tty) lines.push("");
  return lines;
}

/** `sweep status` - what could be freed now, answer first. */
export function printStatusSummary(status: StatusSummary, options: StatusFormatOptions = {}): void {
  for (const line of formatStatusSummary(status, options)) {
    console.log(line);
  }
}

export interface StatsFormatOptions {
  tty?: boolean;
  columns?: number;
  palette?: Palette;
}

/** Format `sweep stats` output with aligned tabular byte and item-count columns. */
export function formatStatsSummary(
  totals: StatsTotals,
  recent: StatsSession[],
  historyFile: string,
  totalSessionCount: number,
  options: StatsFormatOptions = {},
): string[] {
  const tty = options.tty ?? process.stdout.isTTY === true;
  const palette = options.palette ?? createPalette({ stream: { isTTY: tty } });
  const columns = Math.max(56, Math.min(options.columns ?? process.stdout.columns ?? 100, 120));
  const lines: string[] = [];

  if (totalSessionCount === 0) {
    lines.push(palette.dim("No cleanup history yet. Run sweep clean to start the counter."));
    return lines;
  }

  if (tty) {
    lines.push("");
    lines.push(` ${palette.bold(palette.accent("◆ sweep stats"))}`);
    lines.push("");
  }

  lines.push(
    `  ${palette.bold(palette.positive(formatBytes(totals.totalBytesFreed)))} estimated bytes removed or moved ` +
      palette.dim(`across ${plural(totals.sessions, "cleanup")}`),
  );
  if (totals.totalFailed > 0) {
    lines.push(
      palette.dim(`  ${plural(totals.totalFailed, "item")} failed to delete in retained history`),
    );
  }
  lines.push("");

  const sizeWidth = Math.max(9, ...recent.map((entry) => formatBytes(entry.bytesFreed).length));
  const countDigits = Math.max(1, ...recent.map((entry) => String(entry.deleted).length));
  const countColWidth = countDigits + 6; // space + "items"
  const prefixWidth = 2 + 19 + 2 + sizeWidth + 2 + countColWidth + 2;
  const pathBudget = Math.max(16, columns - prefixWidth);

  for (const entry of recent) {
    const stamp = entry.ts.slice(0, 19).replace("T", " ");
    const flags = [entry.trashDir ? "trash" : null, entry.interrupted ? "interrupted" : null]
      .filter(Boolean)
      .join(", ");
    const countText = `${String(entry.deleted).padStart(countDigits)} ${entry.deleted === 1 ? "item " : "items"}`;
    const rawTarget = sanitizeTerminalText(tty ? displayTarget(entry.targetDir) : entry.targetDir);
    const flagSuffix = flags ? `  (${flags})` : "";
    const shownTarget = tty
      ? truncateMiddle(rawTarget, Math.max(12, pathBudget - flagSuffix.length))
      : rawTarget;
    lines.push(
      `  ${palette.dim(stamp)}  ${formatBytes(entry.bytesFreed).padStart(sizeWidth)}  ` +
        `${countText}  ${palette.dim(shownTarget)}` +
        (flags ? palette.warning(flagSuffix) : ""),
    );
  }

  if (totalSessionCount > recent.length) {
    lines.push(palette.dim(`  … ${plural(totalSessionCount - recent.length, "older session")}`));
  }
  const safeLog = sanitizeTerminalText(tty ? displayTarget(historyFile) : historyFile);
  lines.push(
    palette.dim(`  log: ${tty ? truncateMiddle(safeLog, Math.max(16, columns - 8)) : safeLog}`),
  );
  if (tty) lines.push("");
  return lines;
}

/** `sweep stats` - retained estimated cleanup bytes plus recent sessions. */
export function printStatsSummary(
  totals: StatsTotals,
  recent: StatsSession[],
  historyFile: string,
  totalSessionCount: number,
  options: StatsFormatOptions = {},
): void {
  for (const line of formatStatsSummary(totals, recent, historyFile, totalSessionCount, options)) {
    console.log(line);
  }
}

export interface ErrorFormatOptions {
  stream?: { isTTY?: boolean };
  palette?: Palette;
}

/** Format a CLI error with consistent indentation on multiline continuations. */
export function formatError(message: string, options: ErrorFormatOptions = {}): string {
  const stream = options.stream ?? process.stderr;
  const tty = stream.isTTY === true;
  const palette = options.palette ?? createPalette({ stream });
  // Error strings often embed filesystem paths (ENOENT messages quote the
  // failed path verbatim) - sanitize at the chokepoint so every caller is
  // covered, not just the ones that remembered to escape their input.
  const sanitized = sanitizeMultilineTerminalText(message);
  const rawLines = sanitized.split("\n");
  const lead = tty ? `  ${palette.danger("✗")} ` : "  error: ";
  const contIndent = " ".repeat(tty ? 4 : 9);
  const formatted = rawLines
    .map((line, index) => (index === 0 ? `${lead}${line}` : `${contIndent}${line}`))
    .join("\n");
  return `\n${formatted}\n\n`;
}

export function printError(message: string, options: ErrorFormatOptions = {}): void {
  console.error(formatError(message, options).replace(/\n$/, ""));
}
