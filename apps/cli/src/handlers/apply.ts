import type { ApplyReport } from "@kitsunekode/sweep-protocol";
import { PROTOCOL_VERSION } from "@kitsunekode/sweep-protocol";
import {
  GuardrailError,
  assertSafeCwd,
  assertSizeLimit,
  assertTargetDirectory,
} from "@kitsunekode/sweep-core/guardrails";
import { loadConfig } from "@kitsunekode/sweep-core/config";
import { getSelectedBytes, loadPlan } from "@kitsunekode/sweep-core/plan";
import {
  formatBytes,
  printCleanResult,
  printDeclined,
  printInterrupted,
} from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  executePlanDeletion,
  promptConfirm,
  resolveEngineBackend,
  writeJson,
} from "./shared.js";

export type ApplyHandlerOptions = {
  plan: string;
  yes: boolean;
  forceLarge?: boolean;
  json?: boolean;
  color: boolean;
  engine?: import("@kitsunekode/sweep-protocol").EngineBackend;
};

export async function handleApply(opts: ApplyHandlerOptions): Promise<void> {
  applyNoColor(opts.color);

  try {
    const plan = loadPlan(opts.plan);
    assertSafeCwd(plan.targetDir);
    assertTargetDirectory(plan.targetDir);

    const selectedCount = plan.selectedCandidateIds.length;

    if (selectedCount === 0) {
      const report: ApplyReport = {
        protocolVersion: PROTOCOL_VERSION,
        targetDir: plan.targetDir,
        selectedCandidateIds: [],
        deletedCount: 0,
        failedCount: 0,
        totalBytesFreed: 0,
        failedPaths: [],
      };
      if (opts.json) {
        writeJson(report);
      } else {
        console.log("Nothing selected to apply.");
      }
      exitWith(EXIT.OK);
    }

    if (opts.forceLarge && !opts.yes) {
      throw new GuardrailError(
        "--force-large requires --yes. Large deletes must be non-interactive.",
      );
    }

    // The plan path must enforce the same size ceiling as interactive flows —
    // a saved or shared plan is not a trusted lane around maxSizeGB.
    const config = loadConfig(plan.targetDir);
    assertSizeLimit(getSelectedBytes(plan), config.maxSizeGB, opts.forceLarge ?? false);

    if (!opts.yes) {
      const totalBytes = getSelectedBytes(plan);
      const confirmed = await promptConfirm(
        `Apply plan with ${selectedCount} items (~${formatBytes(totalBytes)})?`,
      );
      if (!confirmed) {
        printDeclined();
        exitWith(EXIT.ABORTED);
      }
    }

    const engine = resolveEngineBackend({ engine: opts.engine ?? "js" });

    const { report, cleanResult, interrupted } = await executePlanDeletion(
      plan,
      engine,
      opts.json ? { quiet: true } : {},
    );

    if (opts.json) {
      writeJson(report);
    } else {
      printCleanResult({
        ...cleanResult,
        failedPaths: report.failedPaths,
      });
      if (interrupted) {
        printInterrupted(report.deletedCount, selectedCount);
      }
    }

    exitWith(interrupted ? EXIT.ABORTED : report.failedCount > 0 ? EXIT.FAILURE : EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
