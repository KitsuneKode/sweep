import type { ApplyReport } from "@kitsunekode/sweep-protocol";
import { PROTOCOL_VERSION } from "@kitsunekode/sweep-protocol";
import { assertSafeCwd } from "@kitsunekode/sweep-core/guardrails";
import { getSelectedBytes, loadPlan } from "@kitsunekode/sweep-core/plan";
import { formatBytes, printCleanResult, printDeclined } from "@kitsunekode/sweep-display";
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
  json?: boolean;
  color: boolean;
  engine?: import("@kitsunekode/sweep-protocol").EngineBackend;
};

export async function handleApply(opts: ApplyHandlerOptions): Promise<void> {
  applyNoColor(opts.color);

  try {
    const plan = loadPlan(opts.plan);
    assertSafeCwd(plan.targetDir);

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

    const { report, cleanResult } = await executePlanDeletion(
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
    }

    exitWith(report.failedCount > 0 ? EXIT.FAILURE : EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
