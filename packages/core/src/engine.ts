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
import { assertPathWithinRoot, assertSafeCwd } from "./guardrails.js";
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
  /** True when cancellation stopped scheduling — some candidates were never attempted. */
  interrupted: boolean;
}

export function scanToPlan(
  targetDir: string,
  config: SweepConfig,
  options: ScanToPlanOptions = {},
): Promise<ScanToPlanResult> {
  return scan(targetDir, config, options.exact ?? false, options).then((result) => ({
    result,
    plan: buildPlan(targetDir, result, options.selectionPolicy),
  }));
}

export interface ApplyPlanOptions {
  onDeleted?: (entry: ScanEntry) => void;
  /** JS engine: checked before each delete; true stops scheduling new work. */
  isCancelled?: () => boolean;
  /** Rust engine: aborting kills the engine subprocess. */
  signal?: AbortSignal;
}

export async function applyPlan(
  plan: ScanPlan,
  options: ApplyPlanOptions = {},
): Promise<ApplyPlanResult> {
  assertSafeCwd(plan.targetDir);
  const selected = resolveSelectedCandidates(plan);

  if (selected.length === 0) {
    return emptyApplyPlanResult(plan);
  }

  for (const candidate of selected) {
    assertPathWithinRoot(candidate.path, plan.targetDir);
  }

  const { ready, failedPaths: revalidationFailures } = revalidateCandidates(
    selected,
    plan.targetDir,
  );
  const cleanResult = await clean(
    ready,
    (entry) => {
      options.onDeleted?.(entry);
    },
    options.isCancelled,
  );
  const allFailures = [...revalidationFailures, ...cleanResult.failedPaths];
  // Skipped (unattempted) entries land in neither list — that's the interrupt signal.
  const interrupted = cleanResult.deleted.length + cleanResult.failedPaths.length < ready.length;

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
    interrupted,
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
    interrupted: false,
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

  assertSafeCwd(plan.targetDir);
  const selected = resolveSelectedCandidates(plan);
  if (selected.length === 0) {
    return emptyApplyPlanResult(plan);
  }

  for (const candidate of selected) {
    assertPathWithinRoot(candidate.path, plan.targetDir);
  }

  const report = await applyPlanViaRust(plan, options.signal);
  const failedPathSet = new Set(report.failedPaths.map((failure) => failure.path));
  const revalidationCodes = new Set<PathFailure["code"]>([
    "missing",
    "changed_symlink_state",
    "changed_entry_type",
  ]);
  const revalidationFailures = report.failedPaths.filter((failure) =>
    revalidationCodes.has(failure.code),
  );
  const deleted = selected.filter((candidate) => !failedPathSet.has(candidate.path));
  const ready = selected.filter(
    (candidate) => !revalidationFailures.some((failure) => failure.path === candidate.path),
  );

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
    ready,
    revalidationFailures,
    interrupted: options.signal?.aborted ?? false,
  };
}
