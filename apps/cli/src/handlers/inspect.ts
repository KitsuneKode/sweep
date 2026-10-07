import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { getSelectedBytes, loadPlan } from "@kitsunekode/sweep-core/plan";
import { printPlanInfo } from "@kitsunekode/sweep-display";
import { realpathSync } from "node:fs";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import { applyNoColor, drainStdout, warnIgnoredOptions, writeJson } from "./shared.js";

export type InspectHandlerOptions = CliOptions & {
  plan: string;
  json?: boolean;
};

function countBy<T extends string>(values: T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/** `sweep inspect` - print a saved plan's provenance and totals without applying it. */
export async function handleInspect(opts: InspectHandlerOptions): Promise<void> {
  applyNoColor(opts.color);
  warnIgnoredOptions(opts, "inspect", { except: ["--json"] });

  try {
    const plan = loadPlan(opts.plan);

    // Best-effort canonical view: a plan spelled through symlinked or magic
    // roots (/proc/self/cwd) must not hide where apply actually operates. A
    // vanished root just leaves the field absent.
    let resolvedTargetDir: string | undefined;
    try {
      resolvedTargetDir = realpathSync(plan.targetDir);
    } catch {
      // leave absent
    }

    const summary = {
      protocolVersion: plan.protocolVersion,
      createdAt: plan.createdAt,
      targetDir: plan.targetDir,
      ...(resolvedTargetDir !== undefined ? { resolvedTargetDir } : {}),
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
    await drainStdout();
    exitWith(EXIT.OK);
  } catch (err) {
    handleFatalError(err, { json: opts.json });
  }
}
