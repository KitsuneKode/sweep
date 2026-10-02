import pc from "picocolors";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { sanitizeMultilineTerminalText, sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes, formatScanElapsed } from "./bytes.js";
import { groupCandidatesByKind } from "./grouping.js";
import { formatRiskBadge, riskBadgeLabel } from "./risk.js";
import { createSpinner } from "./spinner.js";

export interface PrintGroupedScanPlanOptions {
  verbose?: boolean;
  /** Wall-clock scan time - printed in the header when provided. */
  elapsedMs?: number;
  /** Backend that produced the plan - printed in the header when provided. */
  engine?: string;
}

const WORKSPACE_STUB_REASON = "workspace-stub";
const SYMLINK_ALIAS_REASON = "symlink-alias";

export { formatBytes, formatScanElapsed } from "./bytes.js";
export { createSpinner, type Spinner } from "./spinner.js";
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
export { sanitizeTerminalText, sanitizeMultilineTerminalText } from "@kitsunekode/sweep-protocol";

// ─── Layout primitives ────────────────────────────────────────────────────────
//
// The terminal is the viewport. Treat it like a fixed-width typeset page: a
// brand color for identity, dim gray for metadata, semantic color only for
// risk. Columns align so the eye can scan name → path → size → risk without
// re-reading each line.

const RULE = "─";
const NAME_COL = 28;

function isTTY(): boolean {
  return process.stdout.isTTY === true;
}

function padEnd(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function rule(width = 64): string {
  return pc.dim(RULE.repeat(Math.min(width, 64)));
}

function countSelected(candidates: ScanCandidate[], selectedIds: Set<string>): number {
  return candidates.filter((candidate) => selectedIds.has(candidate.id)).length;
}

function sumBytes(candidates: ScanCandidate[], selectedIds: Set<string>): number {
  return candidates
    .filter((candidate) => selectedIds.has(candidate.id))
    .reduce((sum, candidate) => sum + candidate.estimatedBytes, 0);
}

// ─── Output sections ──────────────────────────────────────────────────────────

export function printBanner(): void {
  if (!isTTY()) return;
  console.log(`\n ${pc.bold(pc.cyan("sweep"))} ${pc.dim("·")} ${pc.dim("artifact cleanup")}\n`);
}

export function printGroupedScanPlan(
  plan: ScanPlan,
  targetDir: string,
  options: PrintGroupedScanPlanOptions = {},
): void {
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
  const header = `Scanned ${plan.summary.scannedDirs} dirs${skipped} in ${shownTarget}${elapsed}${engine}`;
  if (isTTY()) {
    console.log(pc.dim(header));
    console.log(rule());
  } else {
    console.log(`sweep: ${header.charAt(0).toLowerCase()}${header.slice(1)}`);
  }

  if (plan.candidates.length === 0) {
    console.log();
    console.log(`  ${pc.green("✓")} ${pc.bold("Nothing to clean.")}`);
    console.log();
    return;
  }

  const hiddenStubs = verbose
    ? []
    : plan.candidates.filter((candidate) => isWorkspaceStub(candidate));
  const visibleCandidates = verbose
    ? plan.candidates
    : plan.candidates.filter((candidate) => !isWorkspaceStub(candidate));

  printGroupedCandidates(
    groupCandidatesByKind(visibleCandidates),
    plan.summary.exact,
    selectedIds,
    verbose,
  );

  printScanTotals(plan, selectedIds, hiddenStubs.length, verbose);
}

function isWorkspaceStub(candidate: ScanCandidate): boolean {
  return candidate.reasons.includes(WORKSPACE_STUB_REASON);
}

function candidateRail(selected: boolean, candidate: ScanCandidate): string {
  if (selected) return pc.green("●");
  if (isWorkspaceStub(candidate)) return pc.dim("↳");
  if (candidate.riskTier === "caution") return pc.yellow("○");
  if (candidate.riskTier === "dangerous" || candidate.riskTier === "blocked") return pc.red("◌");
  return pc.dim("·");
}

function insightBadge(candidate: ScanCandidate): string {
  if (candidate.reasons.includes(WORKSPACE_STUB_REASON)) return pc.dim(" workspace stub");
  if (candidate.reasons.includes(SYMLINK_ALIAS_REASON)) return pc.dim(" symlink alias");
  if (candidate.isSymlink) return pc.dim(" symlink");
  return "";
}

function printScanTotals(
  plan: ScanPlan,
  selectedIds: Set<string>,
  hiddenStubCount: number,
  verbose: boolean,
): void {
  const exact = plan.summary.exact;
  const sizePrefix = exact ? "" : "~";
  const totalLabel = exact ? "measured" : "estimated";
  const selectedBytes = sumBytes(plan.candidates, selectedIds);

  if (isTTY()) {
    console.log(rule());
    console.log(
      `  ${pc.bold(plan.selectedCandidateIds.length.toString())} selected` +
        pc.dim("  /  ") +
        `${pc.bold(plan.candidates.length.toString())} found` +
        pc.dim("  /  ") +
        `${pc.yellow(`${sizePrefix}${formatBytes(selectedBytes)}`)} ${totalLabel} selected size`,
    );

    if (hiddenStubCount > 0 && !verbose) {
      console.log(
        pc.dim(
          `  ${hiddenStubCount} workspace node_modules ${hiddenStubCount === 1 ? "stub" : "stubs"} hidden, ${pc.bold("--verbose")} to list`,
        ),
      );
    }

    console.log();
    return;
  }

  console.log(
    `sweep: ${plan.selectedCandidateIds.length} selected, ${plan.candidates.length} found (${sizePrefix}${formatBytes(selectedBytes)} ${totalLabel} selected size)`,
  );
  if (hiddenStubCount > 0 && !verbose) {
    console.log(`sweep: ${hiddenStubCount} workspace node_modules stubs hidden`);
  }
}

function printGroupedCandidates(
  groups: ReturnType<typeof groupCandidatesByKind>,
  exact: boolean,
  selectedIds: Set<string>,
  verbose: boolean,
): void {
  const sizePrefix = exact ? "" : "~";

  for (const group of groups) {
    const selectedInGroup = countSelected(group.entries, selectedIds);
    const groupTag = `${group.entries.length} found${
      selectedInGroup > 0 ? `, ${selectedInGroup} selected` : ""
    }`;

    if (isTTY()) {
      console.log(
        `  ${pc.bold(pc.cyan(group.label))}  ${pc.dim(groupTag)}  ${pc.yellow(
          `${sizePrefix}${formatBytes(group.totalBytes)}`,
        )}`,
      );
    } else {
      console.log(
        `sweep: group ${group.label} (${group.entries.length}) ${sizePrefix}${formatBytes(group.totalBytes)}`,
      );
    }

    for (const entry of group.entries) {
      // A partially-sized subtree undercounts - mark the row so a missing
      // unreadable chunk never reads as the real freed-bytes figure.
      const size = `${entry.bytesKnown === false ? "~" : ""}${formatBytes(entry.estimatedBytes)}`;
      const selected = selectedIds.has(entry.id);
      const badge = ` ${formatRiskBadge(entry.riskTier)}`;
      const note = insightBadge(entry);

      if (isTTY()) {
        console.log(
          `    ${candidateRail(selected, entry)} ${pc.bold(padEnd(sanitizeTerminalText(entry.name), NAME_COL))}` +
            `  ${pc.dim(sanitizeTerminalText(entry.path))}` +
            `  ${pc.yellow(`${sizePrefix}${size}`)}` +
            badge +
            note,
        );
      } else {
        console.log(
          `sweep: ${selected ? "selected" : "found"} ${sanitizeTerminalText(entry.name)} (${sanitizeTerminalText(entry.path)}) ${sizePrefix}${size}${badge}${note}`,
        );
      }
    }

    if (verbose && isTTY()) {
      // extra breathing room when every candidate is shown
    }
    console.log();
  }
}

export function printDryRunNotice(): void {
  console.log(pc.dim(pc.italic("  Dry run. No files deleted.")));
  console.log();
}

export function printCleanResult(
  result: import("@kitsunekode/sweep-protocol").CleanResult,
  options: {
    trashDir?: string;
    outcomes?: import("@kitsunekode/sweep-protocol").ApplyOutcome[];
  } = {},
): void {
  const duration =
    result.durationMs < 1000
      ? `${result.durationMs}ms`
      : `${(result.durationMs / 1000).toFixed(1)}s`;
  const verb = options.trashDir ? "Moved" : "Cleaned";

  if (process.stdout.isTTY) {
    console.log(
      `${pc.green("✓")} ${verb} ${pc.bold(result.deleted.length.toString())} items, ` +
        `~${pc.bold(pc.green(formatBytes(result.totalBytesFreed)))} estimated bytes ${options.trashDir ? "moved" : "removed"} ` +
        pc.dim(`(${duration})`),
    );
  } else {
    console.log(
      `sweep: done, ~${formatBytes(result.totalBytesFreed)} estimated bytes ${options.trashDir ? "moved" : "removed"} in ${duration}`,
    );
  }

  const covered = options.outcomes?.filter((outcome) => outcome.status === "covered").length ?? 0;
  const unattempted =
    options.outcomes?.filter((outcome) => outcome.status === "unattempted").length ?? 0;
  if (covered)
    console.log(
      pc.dim(`  ${covered} nested or duplicate selection(s) covered by completed operations.`),
    );
  if (unattempted) console.log(pc.yellow(`  ${unattempted} selection(s) not attempted.`));

  if (options.trashDir) {
    console.log(
      pc.dim(
        `  restore: entries moved to ${sanitizeTerminalText(options.trashDir)}: ` +
          `delete that directory to reclaim the space.`,
      ),
    );
  }

  if (result.failedPaths.length > 0) {
    console.log();
    console.log(pc.yellow(`⚠ ${result.failedPaths.length} item(s) failed to delete:`));
    for (const { path, error } of result.failedPaths) {
      console.log(
        `  ${pc.dim(sanitizeTerminalText(path))}: ${pc.red(sanitizeTerminalText(error))}`,
      );
    }
  }
}

export function printAborted(): void {
  console.log(pc.dim("Aborted."));
}

/** Deletion was interrupted (SIGINT) - some entries were removed, the rest untouched. */
export function printInterrupted(
  deleted: number,
  total: number,
  options: { verb?: string } = {},
): void {
  console.log();
  console.log(
    pc.yellow(
      `⚠ Interrupted: ${deleted} of ${total} item(s) ${options.verb ?? "deleted"}. ` +
        `The rest were left in place.`,
    ),
  );
}

/** Neutral message shown when the user declines a confirmation prompt. */
export function printDeclined(): void {
  console.log(pc.dim("Declined. Nothing deleted."));
}

export interface PlanInfoSummary {
  protocolVersion: string;
  createdAt: string;
  targetDir: string;
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

/** `sweep inspect` - provenance + totals for a saved plan, no apply. */
export function printPlanInfo(planPath: string, summary: PlanInfoSummary): void {
  console.log(`  ${pc.bold("plan")}      ${sanitizeTerminalText(planPath)}`);
  console.log(`    target      ${sanitizeTerminalText(summary.targetDir)}`);
  console.log(`    created     ${summary.createdAt}`);
  console.log(`    protocol    v${summary.protocolVersion}`);
  console.log(
    `    candidates  ${summary.candidateCount} ` +
      pc.dim(
        `(${Object.entries(summary.kinds)
          .map(([kind, n]) => `${n} ${kind}`)
          .join(", ")})`,
      ),
  );
  console.log(
    `    risk        ${Object.entries(summary.risks)
      .map(([tier, n]) => `${n} ${tier}`)
      .join(", ")}`,
  );
  console.log(
    `    selected    ${summary.selectedCount} items · ${formatBytes(summary.selectedBytes)}`,
  );
  console.log(
    `    scanned     ${summary.scannedDirs} dirs · ~${formatBytes(summary.estimatedTotalBytes)}` +
      (summary.skippedDirs > 0 ? pc.yellow(` · ${summary.skippedDirs} skipped (unreadable)`) : ""),
  );
  console.log(`    exact sizes ${summary.exact ? pc.green("yes") : pc.dim("no")}`);
  console.log();
  console.log(pc.dim(`  apply with: sweep apply --plan ${sanitizeTerminalText(planPath)}`));
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

/** `sweep stats` - retained estimated cleanup bytes plus recent sessions. */
export function printStatsSummary(
  totals: StatsTotals,
  recent: StatsSession[],
  historyFile: string,
  totalSessionCount: number,
): void {
  if (totalSessionCount === 0) {
    console.log(pc.dim("No cleanup history yet. Run sweep clean to start the counter."));
    return;
  }

  console.log(
    `  ${pc.bold(pc.green(formatBytes(totals.totalBytesFreed)))} estimated bytes removed or moved ` +
      pc.dim(`across ${totals.sessions} cleanup${totals.sessions === 1 ? "" : "s"}`),
  );
  if (totals.totalFailed > 0) {
    console.log(pc.dim(`  ${totals.totalFailed} item(s) failed to delete in retained history`));
  }
  console.log();

  for (const entry of recent) {
    const stamp = entry.ts.slice(0, 19).replace("T", " ");
    const flags = [entry.trashDir ? "trash" : null, entry.interrupted ? "interrupted" : null]
      .filter(Boolean)
      .join(", ");
    console.log(
      `  ${pc.dim(stamp)}  ${formatBytes(entry.bytesFreed).padStart(9)}  ` +
        `${entry.deleted} item(s)  ${pc.dim(sanitizeTerminalText(entry.targetDir))}` +
        (flags ? pc.yellow(`  (${flags})`) : ""),
    );
  }
  if (totalSessionCount > recent.length) {
    console.log(pc.dim(`  … ${totalSessionCount - recent.length} older session(s)`));
  }
  console.log(pc.dim(`  log: ${sanitizeTerminalText(historyFile)}`));
}

export function printError(message: string): void {
  // Error strings often embed filesystem paths (ENOENT messages quote the
  // failed path verbatim) - sanitize at the chokepoint so every caller is
  // covered, not just the ones that remembered to escape their input.
  console.error(`\n  ${pc.red("✗")} ${sanitizeMultilineTerminalText(message)}\n`);
}
