import { resolve } from "node:path";
import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { GuardrailError, assertSafeCwd, assertSizeLimit } from "@kitsunekode/sweep-core/guardrails";
import { getSelectedBytes } from "@kitsunekode/sweep-core/plan";
import { printAborted, printCleanResult, printDryRunNotice } from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  confirmPlanDeletion,
  executePlanDeletion,
  resolveEngineBackend,
  resolveProjectScanConfig,
  resolveScanConfig,
  resolveSelectionPolicy,
  runScanWithDisplay,
  writeJson,
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

    const { result, plan } = await runScanWithDisplay(targetDir, config, {
      exact: false,
      selectionPolicy,
      engine,
      projectConfig,
      spinnerLabel: opts.dryRun ? "Scanning (dry-run)..." : "Scanning...",
      output: {
        ...(opts.quiet ? { quiet: true } : {}),
        ...(opts.verbose ? { verbose: true } : {}),
      },
    });

    if (result.entries.length === 0) {
      if (opts.json) writeJson(plan);
      exitWith(EXIT.OK);
    }

    const selectedBytes = getSelectedBytes(plan);
    assertSizeLimit(selectedBytes, config.maxSizeGB, opts.forceLarge);

    if (opts.dryRun) {
      if (opts.json) {
        writeJson(plan);
      } else {
        printDryRunNotice();
      }
      exitWith(EXIT.OK);
    }

    if (plan.selectedCandidateIds.length === 0) {
      if (opts.json) {
        writeJson(plan);
      } else {
        console.log("Nothing selected by the current policy. Use --select or --include-dangerous.");
      }
      exitWith(EXIT.OK);
    }

    if (!(await confirmPlanDeletion(plan, { yes: opts.yes }))) {
      printAborted();
      exitWith(EXIT.ABORTED);
    }

    const { report, cleanResult } = await executePlanDeletion(
      plan,
      engine,
      opts.json || opts.quiet ? { quiet: true } : {},
    );

    if (opts.json) {
      writeJson(report);
    } else {
      printCleanResult({
        ...cleanResult,
        failedPaths: report.failedPaths,
      });
    }

    exitWith(report.failedCount > 0 ? EXIT.FAILURE : EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
