import pc from "picocolors";
import type { ScanCandidate, ScanEntry } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "./bytes.js";
import { createSpinner } from "./spinner.js";
import { formatRiskBadge } from "./risk.js";

export interface ProgressiveScanSummary {
  scannedDirs: number;
  count: number;
  totalBytes: number;
  exact: boolean;
}

export interface ProgressiveScanRenderer {
  onCandidate: (candidate: ScanCandidate | ScanEntry, riskTier?: ScanCandidate["riskTier"]) => void;
  finish: (summary: ProgressiveScanSummary) => void;
  stopSpinner: () => void;
}

function candidateName(candidate: ScanCandidate | ScanEntry): string {
  return candidate.name;
}

function candidatePath(candidate: ScanCandidate | ScanEntry): string {
  return candidate.path;
}

function candidateBytes(candidate: ScanCandidate | ScanEntry): number {
  return candidate.estimatedBytes;
}

/** Create incremental scan output with a spinner and per-candidate lines. */
export function createProgressiveScanRenderer(
  initialText = "Scanning...",
): ProgressiveScanRenderer {
  const spinner = createSpinner(initialText);
  let count = 0;
  let spinnerActive = true;

  const stopSpinnerIfNeeded = () => {
    if (!spinnerActive) return;
    spinner.stop();
    spinnerActive = false;
  };

  return {
    onCandidate(candidate, riskTier) {
      count++;
      stopSpinnerIfNeeded();

      const size = formatBytes(candidateBytes(candidate));
      const badge = riskTier ? ` ${formatRiskBadge(riskTier)}` : "";
      const symlinkBadge = candidate.isSymlink ? pc.dim(" [symlink]") : "";

      if (process.stdout.isTTY) {
        console.log(
          `  ${pc.red("✗")} ${pc.bold(candidateName(candidate))}` +
            `  ${pc.dim(candidatePath(candidate))}` +
            `  ${pc.yellow(size)}` +
            badge +
            symlinkBadge,
        );
      } else {
        console.log(
          `sweep: found ${candidateName(candidate)} (${candidatePath(candidate)}) ${size}${badge}${symlinkBadge}`,
        );
      }
    },
    finish(summary) {
      stopSpinnerIfNeeded();

      if (summary.count === 0) {
        console.log(pc.green("✓") + " Nothing to clean.");
        return;
      }

      const sizePrefix = summary.exact ? "" : "~";
      const totalLabel = summary.exact ? "total" : "estimated";

      if (process.stdout.isTTY) {
        console.log();
        console.log(
          `  ${pc.bold(summary.count.toString())} items, ` +
            `${pc.yellow(`${sizePrefix}${formatBytes(summary.totalBytes)}`)} ${totalLabel}`,
        );
        console.log(
          pc.dim(`Scanned ${pc.bold(summary.scannedDirs.toString())} dirs`) + pc.dim("."),
        );
        console.log();
      } else {
        console.log(
          `sweep: found ${summary.count} items (${sizePrefix}${formatBytes(summary.totalBytes)} ${totalLabel})`,
        );
        console.log(`sweep: scanned ${summary.scannedDirs} dirs`);
      }
    },
    stopSpinner() {
      stopSpinnerIfNeeded();
    },
  };
}
