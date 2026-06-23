import type { ApplyReport, CleanResult, ScanPlan } from "@kitsunekode/sweep-protocol";
import { assertSizeLimit } from "@kitsunekode/sweep-core/guardrails";
import { getSelectedBytes } from "@kitsunekode/sweep-core/plan";
import type { EngineBackend } from "@kitsunekode/sweep-core/rust-engine";
import { executePlanDeletion } from "./shared.js";

export type ApplyReviewedPlanResult =
  | { status: "nothing" }
  | { status: "dry_run" }
  | { status: "completed"; report: ApplyReport; cleanResult: CleanResult };

/** Shared post-review apply path for `clean` and interactive flows. */
export async function applyReviewedPlan(
  plan: ScanPlan,
  options: {
    maxSizeGB: number;
    forceLarge?: boolean;
    dryRun?: boolean;
    engine: EngineBackend;
    quiet?: boolean;
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

  const { report, cleanResult } = await executePlanDeletion(
    plan,
    options.engine,
    options.quiet ? { quiet: true } : {},
  );

  return { status: "completed", report, cleanResult };
}
