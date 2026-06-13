import { resolve } from "node:path";
import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { applyPlan as executePlan } from "@kitsunekode/sweep-core/engine";
import { GuardrailError, assertSafeCwd, assertSizeLimit } from "@kitsunekode/sweep-core/guardrails";
import { getSelectedBytes } from "@kitsunekode/sweep-core/plan";
import {
  clearDeletionProgress,
  createProgressiveScanRenderer,
  formatBytes,
  printAborted,
  printBanner,
  printCleanResult,
  printDeletionProgress,
  printDryRunNotice,
  printGroupedScanPlan,
} from "@kitsunekode/sweep-display";
import { toCandidate } from "@kitsunekode/sweep-core/planner";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  resolveEngineBackend,
  resolveProjectScanConfig,
  resolveScanConfig,
  resolveSelectionPolicy,
  runScanToPlan,
  promptConfirm,
} from "./shared.js";

export async function handleClean(pathArg: string, opts: CliOptions): Promise<void> {
  applyNoColor(opts.color);

  const targetDir = resolve(pathArg);

  try {
    assertSafeCwd(targetDir);

    if (opts.forceLarge && !opts.yes) {
      throw new GuardrailError(
        "--force-large requires --yes. Large deletes must be non-interactive.",
      );
    }

    const config = resolveScanConfig(targetDir, opts);
    const projectConfig = resolveProjectScanConfig(targetDir, opts);
    const selectionPolicy = resolveSelectionPolicy(opts);
    const engine = resolveEngineBackend(opts);

    printBanner();
    const spinner = createProgressiveScanRenderer(
      opts.dryRun ? "Scanning (exact sizes)..." : "Scanning...",
    );
    const { result, plan } = runScanToPlan(targetDir, config, {
      exact: opts.dryRun,
      selectionPolicy,
      engine,
      projectConfig,
      onEntry: (entry) => {
        const candidate = toCandidate(entry);
        spinner.onCandidate(entry, candidate.riskTier);
      },
    });
    spinner.finish({
      scannedDirs: result.scannedDirs,
      count: result.entries.length,
      totalBytes: result.estimatedTotalBytes,
      exact: result.exact,
    });

    printGroupedScanPlan(plan, targetDir);

    if (result.entries.length === 0) {
      exitWith(EXIT.OK);
    }

    const selectedBytes = getSelectedBytes(plan);
    assertSizeLimit(selectedBytes, config.maxSizeGB, opts.forceLarge);

    if (opts.dryRun) {
      printDryRunNotice();
      exitWith(EXIT.OK);
    }

    if (plan.selectedCandidateIds.length === 0) {
      console.log("Nothing selected by the current policy. Use --select or --include-dangerous.");
      exitWith(EXIT.OK);
    }

    if (!opts.yes) {
      const confirmed = await promptConfirm(
        `Delete ${plan.selectedCandidateIds.length} selected items (~${formatBytes(selectedBytes)})?`,
      );
      if (!confirmed) {
        printAborted();
        exitWith(EXIT.ABORTED);
      }
    }

    const selected = plan.candidates.filter((candidate) =>
      plan.selectedCandidateIds.includes(candidate.id),
    );
    const total = selected.length;
    let current = 0;
    let freedBytes = 0;

    const { report, cleanResult } = await executePlan(plan, {
      onDeleted: (entry) => {
        current++;
        freedBytes += entry.estimatedBytes;
        printDeletionProgress(current, total, entry.path, freedBytes);
      },
    });
    clearDeletionProgress();

    printCleanResult({
      ...cleanResult,
      failedPaths: report.failedPaths,
    });

    exitWith(report.failedCount > 0 ? EXIT.FAILURE : EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
