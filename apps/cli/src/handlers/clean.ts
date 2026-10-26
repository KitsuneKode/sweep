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
import { expectApplyOutput } from "../apply-lifecycle.js";
import {
  applyNoColor,
  assertDangerousConsent,
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
  if (!opts.dryRun) expectApplyOutput();
  applyNoColor(opts.color);

  let operationEntered = false;
  try {
    const targetDir = resolveScanTarget(pathArg);

    if (opts.forceLarge && !opts.yes && !opts.dryRun) {
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

    if (opts.dryRun) {
      if (opts.json) {
        writeJson(plan);
      } else {
        printDryRunNotice();
      }
      await drainStdout();
      exitWith(EXIT.OK);
    }

    assertSizeLimit(getSelectedBytes(plan), config.maxSizeGB, opts.forceLarge);

    if (plan.selectedCandidateIds.length === 0) {
      if (opts.json) {
        writeJson(plan);
      } else {
        // Point at review, not at blanket flags: what the policy left out is
        // exactly what needs a human look (custom patterns, symlinks, names
        // that can hold authored files).
        const counts = plan.summary.riskCounts;
        const unselected = [
          counts.caution > 0 ? `${counts.caution} caution` : "",
          counts.dangerous > 0 ? `${counts.dangerous} dangerous` : "",
          counts.blocked > 0 ? `${counts.blocked} blocked` : "",
        ].filter(Boolean);
        console.log(
          unselected.length > 0
            ? `Nothing selected: only ${unselected.join(", ")} found. Review them one by one with \`sweep ui\`.`
            : "Nothing to clean here.",
        );
      }
      await drainStdout();
      exitWith(EXIT.OK);
    }

    assertDangerousConsent(plan, {
      yes: opts.yes,
      ...(opts.allowDangerous ? { allowDangerous: true } : {}),
      ...(opts.json ? { json: true } : {}),
    });

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
