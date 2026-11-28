import type { ScanCandidate, ScanEntry } from "@kitsunekode/sweep-protocol";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes, formatScanElapsed } from "./bytes.js";
import { createPalette, plural } from "./palette.js";
import { createSpinner } from "./spinner.js";
import { formatRiskBadge } from "./risk.js";

export interface ProgressiveScanSummary {
  scannedDirs: number;
  skippedDirs?: number;
  count: number;
  totalBytes: number;
  exact: boolean;
  /** Scan backend that produced the result - diagnostics under --verbose. */
  engine?: string;
  /** Wall-clock scan time, ms. */
  elapsedMs?: number;
}

export interface ProgressiveScanRenderer {
  onCandidate: (candidate: ScanCandidate | ScanEntry, riskTier?: ScanCandidate["riskTier"]) => void;
  finish: (summary: ProgressiveScanSummary) => void;
  stopSpinner: () => void;
}

function candidateName(candidate: ScanCandidate | ScanEntry): string {
  return sanitizeTerminalText(candidate.name);
}

function candidatePath(candidate: ScanCandidate | ScanEntry): string {
  return sanitizeTerminalText(candidate.path);
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

      const palette = createPalette();
      const size = `${candidate.bytesKnown === false ? "~" : ""}${formatBytes(candidateBytes(candidate))}`;
      const badge = riskTier ? ` ${formatRiskBadge(riskTier, palette)}` : "";
      const symlinkBadge = candidate.isSymlink ? palette.dim(" [symlink]") : "";

      if (process.stdout.isTTY) {
        console.log(
          `  ${palette.dim("·")} ${palette.bold(candidateName(candidate))}` +
            `  ${palette.dim(candidatePath(candidate))}` +
            `  ${palette.bold(size.padStart(10))}` +
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
      const palette = createPalette();

      if (summary.count === 0) {
        console.log(
          process.stdout.isTTY
            ? `${palette.positive("✓")} Nothing to clean.`
            : "sweep: nothing to clean.",
        );
        return;
      }

      const sizePrefix = summary.exact ? "" : "~";
      const totalLabel = summary.exact ? "total" : "estimated";

      const skipped =
        summary.skippedDirs && summary.skippedDirs > 0 ? `, ${summary.skippedDirs} skipped` : "";
      const engine = summary.engine ? palette.dim(` · engine ${summary.engine}`) : "";
      const elapsed =
        summary.elapsedMs !== undefined
          ? palette.dim(` · ${formatScanElapsed(summary.elapsedMs)}`)
          : "";

      if (process.stdout.isTTY) {
        console.log();
        console.log(
          `  ${palette.bold(plural(summary.count, "item"))}, ` +
            `${palette.bold(palette.positive(`${sizePrefix}${formatBytes(summary.totalBytes)}`))} ${totalLabel}`,
        );
        console.log(
          palette.dim(`Scanned ${plural(summary.scannedDirs, "dir")}`) +
            (skipped ? palette.warning(skipped) : "") +
            engine +
            elapsed +
            palette.dim("."),
        );
        console.log();
      } else {
        console.log(
          `sweep: found ${plural(summary.count, "item")} (${sizePrefix}${formatBytes(summary.totalBytes)} ${totalLabel})`,
        );
        console.log(
          `sweep: scanned ${plural(summary.scannedDirs, "dir")}${skipped}${summary.engine ? `, engine=${summary.engine}` : ""}${summary.elapsedMs !== undefined ? `, ${formatScanElapsed(summary.elapsedMs)}` : ""}`,
        );
      }
    },
    stopSpinner() {
      stopSpinnerIfNeeded();
    },
  };
}
