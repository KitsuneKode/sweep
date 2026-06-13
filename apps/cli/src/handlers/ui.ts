import { resolve } from "node:path";
import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { applyPlan as executePlan } from "@kitsunekode/sweep-core/engine";
import { GuardrailError, assertSafeCwd, assertSizeLimit } from "@kitsunekode/sweep-core/guardrails";
import { getSelectedBytes } from "@kitsunekode/sweep-core/plan";
import { printAborted, printCleanResult, printDryRunNotice } from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  resolveEngineBackend,
  resolveScanConfig,
  resolveSelectionPolicy,
  runScanToPlan,
} from "./shared.js";

export async function handleUi(pathArg: string, opts: CliOptions): Promise<void> {
  applyNoColor(opts.color);

  const targetDir = resolve(pathArg);

  try {
    assertSafeCwd(targetDir);

    if (!process.stdout.isTTY) {
      throw new GuardrailError("sweep ui requires a TTY terminal.", 4);
    }

    if (opts.forceLarge && !opts.yes) {
      throw new GuardrailError(
        "--force-large requires --yes. Large deletes must be non-interactive.",
      );
    }

    const config = resolveScanConfig(targetDir, opts);
    const selectionPolicy = resolveSelectionPolicy(opts);
    const engine = resolveEngineBackend(opts);
    const { plan } = runScanToPlan(targetDir, config, { selectionPolicy, engine });

    if (plan.candidates.length === 0) {
      console.log("Nothing to clean.");
      exitWith(EXIT.OK);
    }

    const { runSweepUi } = await import(new URL("../sweep-ui.js", import.meta.url).href);
    const uiResult = await runSweepUi(plan, {
      yes: opts.yes,
      dryRun: opts.dryRun,
      includeDangerous: opts.includeDangerous,
    });

    if (!uiResult) {
      printAborted();
      exitWith(EXIT.ABORTED);
    }

    const selectedPlan = uiResult.plan;
    const selectedBytes = getSelectedBytes(selectedPlan);
    assertSizeLimit(selectedBytes, config.maxSizeGB, opts.forceLarge);

    if (selectedPlan.selectedCandidateIds.length === 0) {
      console.log("Nothing selected.");
      exitWith(EXIT.OK);
    }

    if (opts.dryRun) {
      printDryRunNotice();
      exitWith(EXIT.OK);
    }

    const { report, cleanResult } = await executePlan(selectedPlan);
    printCleanResult({
      ...cleanResult,
      failedPaths: report.failedPaths,
    });

    exitWith(report.failedCount > 0 ? EXIT.FAILURE : EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
