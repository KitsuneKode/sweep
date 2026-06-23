import pc from "picocolors";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "./bytes.js";
import { groupCandidatesByKind } from "./grouping.js";
import { formatRiskBadge } from "./risk.js";
import { createSpinner } from "./spinner.js";

export { formatBytes } from "./bytes.js";
export { createSpinner } from "./spinner.js";
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function padEnd(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

// ─── Output sections ──────────────────────────────────────────────────────────

export function printBanner(): void {
  if (!process.stdout.isTTY) return;
  console.log(`\n ${pc.bold(pc.cyan("sweep"))} ${pc.dim("—")} ${pc.dim("artifact cleanup")}\n`);
}

export function printGroupedScanPlan(plan: ScanPlan, targetDir: string): void {
  if (process.stdout.isTTY) {
    console.log(
      pc.dim(`Scanned ${pc.bold(plan.summary.scannedDirs.toString())} dirs in `) +
        pc.bold(targetDir),
    );
    console.log();
  } else {
    console.log(`sweep: scanned ${plan.summary.scannedDirs} dirs in ${targetDir}`);
  }

  if (plan.candidates.length === 0) {
    console.log(pc.green("✓") + " Nothing to clean.");
    return;
  }

  printGroupedCandidates(groupCandidatesByKind(plan.candidates), plan.summary.exact);
}

function printGroupedCandidates(
  groups: ReturnType<typeof groupCandidatesByKind>,
  exact: boolean,
): void {
  const sizePrefix = exact ? "" : "~";

  for (const group of groups) {
    if (process.stdout.isTTY) {
      console.log(
        pc.bold(pc.cyan(group.label)) +
          pc.dim(`  (${group.entries.length})  `) +
          pc.yellow(`${sizePrefix}${formatBytes(group.totalBytes)}`),
      );
    } else {
      console.log(
        `sweep: group ${group.label} (${group.entries.length}) ${sizePrefix}${formatBytes(group.totalBytes)}`,
      );
    }

    const maxNameLen = Math.max(...group.entries.map((entry) => entry.name.length), 12);

    for (const entry of group.entries) {
      const size = formatBytes(entry.estimatedBytes);
      const symlinkBadge = entry.isSymlink ? pc.dim(" [symlink]") : "";
      const badge = ` ${formatRiskBadge(entry.riskTier)}`;

      if (process.stdout.isTTY) {
        console.log(
          `  ${pc.red("✗")} ${pc.bold(padEnd(entry.name, maxNameLen))}` +
            `  ${pc.dim(entry.path)}` +
            `  ${pc.yellow(`${sizePrefix}${size}`)}` +
            badge +
            symlinkBadge,
        );
      } else {
        console.log(
          `sweep: found ${entry.name} (${entry.path}) ${sizePrefix}${size}${badge}${symlinkBadge}`,
        );
      }
    }

    console.log();
  }

  const totalCount = groups.reduce((sum, group) => sum + group.entries.length, 0);
  const totalBytes = groups.reduce((sum, group) => sum + group.totalBytes, 0);
  const totalLabel = exact ? "total" : "estimated";

  if (process.stdout.isTTY) {
    console.log(
      `  ${pc.bold(totalCount.toString())} items, ` +
        `${pc.yellow(`${sizePrefix}${formatBytes(totalBytes)}`)} ${totalLabel}`,
    );
    console.log();
  } else {
    console.log(
      `sweep: found ${totalCount} items (${sizePrefix}${formatBytes(totalBytes)} ${totalLabel})`,
    );
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

export function printError(message: string): void {
  console.error(`\n  ${pc.red("✗")} ${message}\n`);
}
