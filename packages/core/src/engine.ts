import type {
  ApplyReport,
  CleanResult,
  ScanCandidate,
  ScanEntry,
  ScanPlan,
  ScanResult,
  SweepConfig,
} from "../../protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../protocol/src/index.js";
import { clean } from "./cleaner.js";
import type { ScanHooks } from "./scanner.js";
import { scan } from "./scanner.js";
import { buildPlan, resolveSelectedCandidates, revalidateCandidates } from "./planner.js";

export interface ScanToPlanOptions extends ScanHooks {
  exact?: boolean;
}

export interface ScanToPlanResult {
  result: ScanResult;
  plan: ScanPlan;
}

export interface ApplyPlanResult {
  report: ApplyReport;
  cleanResult: CleanResult;
  selected: ScanCandidate[];
  ready: ScanEntry[];
  revalidationFailures: Array<{ path: string; error: string }>;
}

export function scanToPlan(
  targetDir: string,
  config: SweepConfig,
  options: ScanToPlanOptions = {},
): ScanToPlanResult {
  const result = scan(targetDir, config, options.exact ?? false, options);
  return {
    result,
    plan: buildPlan(targetDir, result),
  };
}

export async function applyPlan(plan: ScanPlan): Promise<ApplyPlanResult> {
  const selected = resolveSelectedCandidates(plan);

  if (selected.length === 0) {
    return {
      report: {
        protocolVersion: PROTOCOL_VERSION,
        targetDir: plan.targetDir,
        selectedCandidateIds: [],
        deletedCount: 0,
        failedCount: 0,
        totalBytesFreed: 0,
        failedPaths: [],
      },
      cleanResult: {
        deleted: [],
        failedPaths: [],
        totalBytesFreed: 0,
        durationMs: 0,
      },
      selected: [],
      ready: [],
      revalidationFailures: [],
    };
  }

  const { ready, failedPaths: revalidationFailures } = revalidateCandidates(selected);
  const cleanResult = await clean(ready);
  const allFailures = [...revalidationFailures, ...cleanResult.failedPaths];

  return {
    report: {
      protocolVersion: PROTOCOL_VERSION,
      targetDir: plan.targetDir,
      selectedCandidateIds: selected.map((candidate) => candidate.id),
      deletedCount: cleanResult.deleted.length,
      failedCount: allFailures.length,
      totalBytesFreed: cleanResult.totalBytesFreed,
      failedPaths: allFailures,
    },
    cleanResult,
    selected,
    ready,
    revalidationFailures,
  };
}
