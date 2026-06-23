import { DEFAULT_PATTERNS, buildRescanConfig } from "@kitsunekode/sweep-core/config";
import { assertSizeLimit } from "@kitsunekode/sweep-core/guardrails";
import { getSelectedBytes } from "@kitsunekode/sweep-core/plan";
import type {
  ApplyReport,
  CleanResult,
  ScanPlan,
  SelectionPolicy,
  SweepConfig,
} from "@kitsunekode/sweep-protocol";
import type { EngineBackend } from "@kitsunekode/sweep-core/rust-engine";
import { executePlanDeletion, runScanToPlan } from "../handlers/shared.js";

export interface InteractiveCleanupDeps {
  scan: typeof runScanToPlan;
  deletePlan: typeof executePlanDeletion;
}

const defaultDeps: InteractiveCleanupDeps = {
  scan: runScanToPlan,
  deletePlan: executePlanDeletion,
};

export type SweepUiOutcome =
  | { type: "apply"; plan: ScanPlan }
  | { type: "rescan"; disabledPatterns: string[]; extraPatterns: string[] }
  | { type: "abort" };

export interface ReviewContext {
  init: {
    catalogPatterns: string[];
    disabledPatterns: string[];
    extraPatterns: string[];
  };
  dryRun?: boolean;
  yes?: boolean;
}

export type ReviewAdapter = (plan: ScanPlan, ctx: ReviewContext) => Promise<SweepUiOutcome>;

export type InteractiveOutcome =
  | { type: "completed"; report: ApplyReport; cleanResult: CleanResult }
  | { type: "aborted" }
  | { type: "nothing"; reason: "no_candidates" | "none_selected" }
  | { type: "dry_run" };

export interface InteractiveCleanupOptions {
  targetDir: string;
  scanConfig: SweepConfig;
  projectConfig: SweepConfig;
  selectionPolicy: SelectionPolicy;
  engine: EngineBackend;
  review: ReviewAdapter;
  dryRun?: boolean;
  yes?: boolean;
  forceLarge?: boolean;
  onScanStart?: () => void;
  onScanProgress?: (found: number) => void;
  /** Called after scan finishes and before the review adapter runs (e.g. stop stdout spinner). */
  onScanComplete?: () => void;
}

export async function runInteractiveCleanup(
  options: InteractiveCleanupOptions,
  deps: InteractiveCleanupDeps = defaultDeps,
): Promise<InteractiveOutcome> {
  let scanConfig = options.scanConfig;
  let disabledPatterns = scanConfig.disabledPatterns ?? [];
  let extraPatterns = scanConfig.patterns.filter(
    (pattern) => !new Set<string>(DEFAULT_PATTERNS).has(pattern),
  );

  while (true) {
    options.onScanStart?.();
    let found = 0;
    const { plan } = await deps.scan(options.targetDir, scanConfig, {
      selectionPolicy: options.selectionPolicy,
      engine: options.engine,
      projectConfig: options.projectConfig,
      onEntrySized: () => {
        found += 1;
        options.onScanProgress?.(found);
      },
    });

    options.onScanComplete?.();

    if (plan.candidates.length === 0) {
      return { type: "nothing", reason: "no_candidates" };
    }

    const outcome = await options.review(plan, {
      init: {
        catalogPatterns: [...DEFAULT_PATTERNS],
        disabledPatterns,
        extraPatterns,
      },
      ...(options.dryRun ? { dryRun: true } : {}),
      ...(options.yes ? { yes: true } : {}),
    });

    if (outcome.type === "abort") {
      return { type: "aborted" };
    }

    if (outcome.type === "rescan") {
      disabledPatterns = outcome.disabledPatterns;
      extraPatterns = outcome.extraPatterns;
      scanConfig = buildRescanConfig(scanConfig, {
        disabledPatterns,
        extraPatterns,
      });
      continue;
    }

    const selectedPlan = outcome.plan;
    const selectedBytes = getSelectedBytes(selectedPlan);
    assertSizeLimit(selectedBytes, scanConfig.maxSizeGB, options.forceLarge ?? false);

    if (selectedPlan.selectedCandidateIds.length === 0) {
      return { type: "nothing", reason: "none_selected" };
    }

    if (options.dryRun) {
      return { type: "dry_run" };
    }

    const { report, cleanResult } = await deps.deletePlan(selectedPlan, options.engine);
    return { type: "completed", report, cleanResult };
  }
}
