import type { ApplyReport, CleanResult, ScanPlan } from "@kitsunekode/sweep-protocol";
import { assertSizeLimit } from "@kitsunekode/sweep-core/guardrails";
import { getSelectedBytes } from "@kitsunekode/sweep-core/plan";
import type { EngineBackend } from "@kitsunekode/sweep-core/rust-engine";
import { executePlanDeletion } from "./shared.js";

export type ApplyReviewedPlanResult =
  | { status: "nothing" }
  | { status: "dry_run" }
  | {
      status: "completed";
      report: ApplyReport;
      cleanResult: CleanResult;
      /** SIGINT stopped scheduling mid-apply - report covers what landed. */
      interrupted: boolean;
      /** Set when entries were moved instead of deleted. */
      trashDir?: string;
    };

/** Shared post-review apply path for `clean` and interactive flows. */
export async function applyReviewedPlan(
  plan: ScanPlan,
  options: {
    maxSizeGB: number;
    forceLarge?: boolean;
    dryRun?: boolean;
    engine: EngineBackend;
    quiet?: boolean;
    trash?: boolean;
  },
): Promise<ApplyReviewedPlanResult> {
  const selectedBytes = getSelectedBytes(plan);
  assertSizeLimit(selectedBytes, options.maxSizeGB, options.forceLarge ?? false);

  if (plan.selectedCandidateIds.length === 0) {
    return { status: "nothing" };
  }

  if (options.dryRun) {
    return { status: "dry_run" };
  }

  const { report, cleanResult, interrupted, trashDir } = await executePlanDeletion(
    plan,
    options.engine,
    {
      ...(options.quiet ? { quiet: true } : {}),
      ...(options.trash ? { trash: true } : {}),
    },
  );

  return {
    status: "completed",
    report,
    cleanResult,
    interrupted,
    ...(trashDir ? { trashDir } : {}),
  };
}
