import { getSelectedBytes, loadPlan } from "@kitsunekode/sweep-core/plan";
import { printPlanInfo } from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import { applyNoColor, writeJson } from "./shared.js";

export type InspectHandlerOptions = {
  plan: string;
  json?: boolean;
  color: boolean;
};

function countBy<T extends string>(values: T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/** `sweep inspect` — print a saved plan's provenance and totals without applying it. */
export async function handleInspect(opts: InspectHandlerOptions): Promise<void> {
  applyNoColor(opts.color);

  try {
    const plan = loadPlan(opts.plan);

    const summary = {
      protocolVersion: plan.protocolVersion,
      createdAt: plan.createdAt,
      targetDir: plan.targetDir,
      candidateCount: plan.candidates.length,
      selectedCount: plan.selectedCandidateIds.length,
      selectedBytes: getSelectedBytes(plan),
      estimatedTotalBytes: plan.summary.estimatedTotalBytes,
      scannedDirs: plan.summary.scannedDirs,
      skippedDirs: plan.summary.skippedDirs ?? 0,
      exact: plan.summary.exact,
      kinds: countBy(plan.candidates.map((candidate) => candidate.kind)),
      risks: countBy(plan.candidates.map((candidate) => candidate.riskTier)),
    };

    if (opts.json) {
      writeJson(summary);
    } else {
      printPlanInfo(opts.plan, summary);
    }
    exitWith(EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
