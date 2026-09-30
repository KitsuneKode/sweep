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
  warnIgnoredOptions,
  writeJson,
} from "./shared.js";

export type ApplyHandlerOptions = import("@kitsunekode/sweep-protocol").CliOptions & {
  plan: string;
  trash?: boolean;
  json?: boolean;
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

    // The plan path must enforce the same size ceiling as interactive flows -
    // a saved or shared plan is not a trusted lane around maxSizeGB.
    const config = loadConfig(plan.targetDir);
    assertSizeLimit(getSelectedBytes(plan), config.maxSizeGB, opts.forceLarge ?? false);

    if (opts.dryRun) {
      // A plan "preview" must never delete: report what applying would do.
      const totalBytes = getSelectedBytes(plan);
      if (opts.json) {
        writeJson(plan);
      } else {
        console.log(
          `Dry run: would ${opts.trash ? "move to .sweep-trash" : "delete"} ${selectedCount} item(s) (~${formatBytes(totalBytes)}).`,
        );
      }
      exitWith(EXIT.OK);
    }

    warnIgnoredOptions(opts, "apply", { applies: true, except: ["--json"] });

    if (!opts.yes) {
      const totalBytes = getSelectedBytes(plan);
      const action = opts.trash
        ? `Move ${selectedCount} plan items to .sweep-trash`
        : `Apply plan with ${selectedCount} items`;
      const confirmed = await promptConfirm(`${action} (~${formatBytes(totalBytes)})?`);
      if (!confirmed) {
        // A decline under --json emits no stdout at all - exit code carries it.
        if (!opts.json) printDeclined();
        exitWith(EXIT.ABORTED);
      }
    }

    const engine = resolveEngineBackend({ engine: opts.engine ?? "auto" });

    const { report, cleanResult, interrupted, trashDir } = await executePlanDeletion(plan, engine, {
      ...(opts.json ? { quiet: true } : {}),
      ...(opts.trash ? { trash: true } : {}),
    });

    if (opts.json) {
      writeJson(report);
    } else {
      printCleanResult(
        {
          ...cleanResult,
          failedPaths: report.failedPaths,
        },
        trashDir ? { trashDir } : {},
      );
      if (interrupted) {
        printInterrupted(report.deletedCount, selectedCount, {
          verb: trashDir ? "moved" : "deleted",
        });
      }
    }

    exitWith(interrupted ? EXIT.ABORTED : report.failedCount > 0 ? EXIT.FAILURE : EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
