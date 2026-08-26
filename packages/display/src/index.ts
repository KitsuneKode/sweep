import pc from "picocolors";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "./bytes.js";
import { groupCandidatesByKind } from "./grouping.js";
import { formatRiskBadge, riskBadgeLabel } from "./risk.js";
import { createSpinner } from "./spinner.js";

export interface PrintGroupedScanPlanOptions {
  verbose?: boolean;
}

const WORKSPACE_STUB_REASON = "workspace-stub";
const SYMLINK_ALIAS_REASON = "symlink-alias";

export { formatBytes } from "./bytes.js";
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
  printDeletionProgress,
} from "./deletion.js";
export {
  createProgressiveScanRenderer,
  type ProgressiveScanRenderer,
  type ProgressiveScanSummary,
} from "./progressive.js";

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

  const header = `Scanned ${plan.summary.scannedDirs} dirs in ${targetDir}`;
  if (isTTY()) {
    console.log(pc.dim(header));
    console.log(rule());
  } else {
    console.log(`sweep: scanned ${plan.summary.scannedDirs} dirs in ${targetDir}`);
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
  const totalLabel = exact ? "total" : "estimated";
  const selectedBytes = sumBytes(plan.candidates, selectedIds);

  if (isTTY()) {
    console.log(rule());
    console.log(
      `  ${pc.bold(plan.selectedCandidateIds.length.toString())} selected` +
        pc.dim("  /  ") +
        `${pc.bold(plan.candidates.length.toString())} found` +
        pc.dim("  /  ") +
        `${pc.yellow(`${sizePrefix}${formatBytes(selectedBytes)}`)} ${totalLabel} to free`,
    );

    if (hiddenStubCount > 0 && !verbose) {
      console.log(
        pc.dim(
          `  ${hiddenStubCount} workspace node_modules ${hiddenStubCount === 1 ? "stub" : "stubs"} hidden — ${pc.bold("--verbose")} to list`,
        ),
      );
    }

    console.log();
    return;
  }

  console.log(
    `sweep: ${plan.selectedCandidateIds.length} selected, ${plan.candidates.length} found (${sizePrefix}${formatBytes(selectedBytes)} ${totalLabel} to free)`,
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

    const maxNameLen = Math.max(...group.entries.map((entry) => entry.name.length), 12);

    for (const entry of group.entries) {
      const size = formatBytes(entry.estimatedBytes);
      const selected = selectedIds.has(entry.id);
      const badge = ` ${formatRiskBadge(entry.riskTier)}`;
      const note = insightBadge(entry);

      if (isTTY()) {
        console.log(
          `    ${candidateRail(selected, entry)} ${pc.bold(padEnd(entry.name, NAME_COL))}` +
            `  ${pc.dim(entry.path)}` +
            `  ${pc.yellow(`${sizePrefix}${size}`)}` +
            badge +
            note,
        );
      } else {
        console.log(
          `sweep: ${selected ? "selected" : "found"} ${entry.name} (${entry.path}) ${sizePrefix}${size}${badge}${note}`,
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
  console.log(pc.dim(pc.italic("  Dry run — no files deleted.")));
  console.log();
}

export function printCleanResult(result: import("@kitsunekode/sweep-protocol").CleanResult): void {
  const duration =
    result.durationMs < 1000
      ? `${result.durationMs}ms`
      : `${(result.durationMs / 1000).toFixed(1)}s`;

  if (process.stdout.isTTY) {
    console.log(
      `${pc.green("✓")} Cleaned ${pc.bold(result.deleted.length.toString())} items, ` +
        `${pc.bold(pc.green(formatBytes(result.totalBytesFreed)))} freed ` +
        pc.dim(`(${duration})`),
    );
  } else {
    console.log(`sweep: done — ${formatBytes(result.totalBytesFreed)} freed in ${duration}`);
  }

  if (result.failedPaths.length > 0) {
    console.log();
    console.log(pc.yellow(`⚠ ${result.failedPaths.length} item(s) failed to delete:`));
    for (const { path, error } of result.failedPaths) {
      console.log(`  ${pc.dim(path)}: ${pc.red(error)}`);
    }
  }
}

export function printAborted(): void {
  console.log(pc.dim("Aborted."));
}

/** Neutral message shown when the user declines a confirmation prompt. */
export function printDeclined(): void {
  console.log(pc.dim("Declined — nothing deleted."));
}

export function printError(message: string): void {
  console.error(`\n  ${pc.red("✗")} ${message}\n`);
}
