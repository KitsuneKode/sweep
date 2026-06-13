import type {
  ApplyReport,
  CleanResult,
  PathFailure,
  ScanCandidate,
  ScanEntry,
  ScanPlan,
  ScanResult,
  SelectionPolicy,
  SweepConfig,
} from "@kitsunekode/sweep-protocol";
import { PROTOCOL_VERSION } from "@kitsunekode/sweep-protocol";
import { clean } from "./cleaner.js";
import type { ScanHooks } from "./scanner.js";
import { scan } from "./scanner.js";
import { buildPlan, resolveSelectedCandidates, revalidateCandidates } from "./planner.js";
import { applyPlanViaRust, type EngineBackend } from "./rust-engine.js";

export interface ScanToPlanOptions extends ScanHooks {
  exact?: boolean;
  selectionPolicy?: SelectionPolicy;
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
  revalidationFailures: PathFailure[];
}

export function scanToPlan(
  targetDir: string,
  config: SweepConfig,
  options: ScanToPlanOptions = {},
): ScanToPlanResult {
  const result = scan(targetDir, config, options.exact ?? false, options);
  return {
    result,
    plan: buildPlan(targetDir, result, options.selectionPolicy),
  };
}

export interface ApplyPlanOptions {
  onDeleted?: (entry: ScanEntry) => void;
}

export async function applyPlan(
  plan: ScanPlan,
  options: ApplyPlanOptions = {},
): Promise<ApplyPlanResult> {
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
  const cleanResult = await clean(ready, (entry) => {
    options.onDeleted?.(entry);
  });
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

function emptyApplyPlanResult(plan: ScanPlan): ApplyPlanResult {
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

export async function applyPlanWithBackend(
  plan: ScanPlan,
  engine: EngineBackend,
  options: ApplyPlanOptions = {},
): Promise<ApplyPlanResult> {
  if (engine !== "rust") {
    return applyPlan(plan, options);
  }

  const selected = resolveSelectedCandidates(plan);
  if (selected.length === 0) {
    return emptyApplyPlanResult(plan);
  }

  const report = applyPlanViaRust(plan);
  const failedPaths = new Set(report.failedPaths.map((failure) => failure.path));
  const deleted = selected.filter((candidate) => !failedPaths.has(candidate.path));

  for (const candidate of deleted) {
    options.onDeleted?.(candidate);
  }

  const cleanResult: CleanResult = {
    deleted,
    failedPaths: report.failedPaths,
    totalBytesFreed: report.totalBytesFreed,
    durationMs: 0,
  };

  return {
    report,
    cleanResult,
    selected,
    ready: deleted,
    revalidationFailures: [],
  };
}
