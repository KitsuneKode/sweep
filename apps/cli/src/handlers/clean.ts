import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { GuardrailError, assertSizeLimit } from "@kitsunekode/sweep-core/guardrails";
import { getSelectedBytes } from "@kitsunekode/sweep-core/plan";
import {
  printCleanResult,
  printDeclined,
  printDryRunNotice,
  printInterrupted,
} from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import { applyReviewedPlan } from "./apply-plan.js";
import {
  applyNoColor,
  confirmPlanDeletion,
  drainStdout,
  resolveEngineBackend,
  resolveProjectScanConfig,
  resolveScanConfig,
  resolveSelectionPolicy,
  resolveScanTarget,
  runScanWithDisplay,
  writeJson,
} from "./shared.js";

export async function handleClean(pathArg: string, opts: CliOptions): Promise<void> {
  applyNoColor(opts.color);

  let operationEntered = false;
  try {
    const targetDir = resolveScanTarget(pathArg);

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
      resourceProfile: opts.resourceProfile,
      spinnerLabel: opts.dryRun ? "Scanning (dry-run)..." : "Scanning...",
      output: {
        // --json output must stay machine-readable - no banner/plan text on stdout.
        ...(opts.quiet || opts.json ? { quiet: true } : {}),
        ...(opts.verbose && !opts.json ? { verbose: true } : {}),
      },
    });

    if (result.entries.length === 0) {
      if (opts.json) writeJson(plan);
      await drainStdout();
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
      await drainStdout();
      exitWith(EXIT.OK);
    }

    if (plan.selectedCandidateIds.length === 0) {
      if (opts.json) {
        writeJson(plan);
      } else {
        console.log("Nothing selected by the current policy. Use --select or --include-dangerous.");
      }
      await drainStdout();
      exitWith(EXIT.OK);
    }

    if (
      !(await confirmPlanDeletion(plan, {
        yes: opts.yes,
        ...(opts.trash ? { trash: true } : {}),
      }))
    ) {
      // A decline under --json emits no stdout at all - exit code carries it.
      if (!opts.json) printDeclined();
      exitWith(EXIT.ABORTED);
    }

    operationEntered = true;
    const applyResult = await applyReviewedPlan(plan, {
      maxSizeGB: config.maxSizeGB,
      forceLarge: opts.forceLarge,
      engine,
      ...(opts.trash ? { trash: true } : {}),
      ...(opts.json || opts.quiet ? { quiet: true } : {}),
    });

    if (applyResult.status !== "completed") {
      await drainStdout();
      exitWith(EXIT.OK);
    }

    const { report, cleanResult, interrupted, trashDir } = applyResult;

    if (opts.json) {
      writeJson(report);
    } else {
      printCleanResult(
        {
          ...cleanResult,
          failedPaths: report.failedPaths,
        },
        {
          ...(report.outcomes ? { outcomes: report.outcomes } : {}),
          ...(trashDir ? { trashDir } : {}),
        },
      );
      if (interrupted) {
        printInterrupted(report.deletedCount, plan.selectedCandidateIds.length, {
          verb: trashDir ? "moved" : "deleted",
        });
      }
    }

    await drainStdout();
    exitWith(interrupted ? EXIT.ABORTED : report.failedCount > 0 ? EXIT.FAILURE : EXIT.OK);
  } catch (err) {
    handleFatalError(err, {
      json: opts.json,
      applyOutcome: operationEntered ? "unknown" : "not_started",
    });
  }
}
