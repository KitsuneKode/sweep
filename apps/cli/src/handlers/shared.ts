import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import type {
  ApplyReport,
  CliOptions,
  ScanPlan,
  ScanResult,
  SelectionMode,
  SelectionPolicy,
  SweepConfig,
} from "@kitsunekode/sweep-protocol";
import { DEFAULT_CONFIG, loadConfig } from "@kitsunekode/sweep-core/config";
import {
  applyPlanWithBackend,
  scanToPlan,
  type ScanToPlanOptions,
} from "@kitsunekode/sweep-core/engine";
import { GuardrailError, assertSafePattern } from "@kitsunekode/sweep-core/guardrails";
import { toCandidate } from "@kitsunekode/sweep-core/planner";
import {
  scanToPlanViaRust,
  isRustEngineAvailable,
  rustScanBlockedReason,
  defaultRustSelectionPolicy,
  type EngineBackend,
} from "@kitsunekode/sweep-core/rust-engine";

export type OutputOptions = Pick<CliOptions, "quiet" | "verbose">;

export function applyNoColor(color: boolean | undefined): void {
  if (!color) {
    process.env.NO_COLOR = "1";
  }
}

export function resolveScanConfig(targetDir: string, opts: CliOptions): SweepConfig {
  const patterns = opts.pattern ?? [];
  const disabledPatterns = opts.disabledPattern ?? [];
  const ignore = opts.ignore ?? [];

  for (const pattern of patterns) assertSafePattern(pattern);
  for (const pattern of disabledPatterns) assertSafePattern(pattern);
  for (const pattern of ignore) assertSafePattern(pattern);

  const cliOverrides: Partial<SweepConfig> = {
    depth: opts.depth,
    ...(patterns.length > 0 ? { patterns } : {}),
    ...(disabledPatterns.length > 0 ? { disabledPatterns } : {}),
    ...(ignore.length > 0 ? { ignore } : {}),
  };

  return loadConfig(targetDir, opts.config, cliOverrides);
}

/** Config from project files only (no CLI pattern/ignore/depth overrides). */
export function resolveProjectScanConfig(targetDir: string, opts: CliOptions): SweepConfig {
  return loadConfig(targetDir, opts.config, {});
}

export function resolveEngineBackend(opts: Pick<CliOptions, "engine">): EngineBackend {
  if (opts.engine === "js") return "js";
  if (opts.engine === "rust") return "rust";
  return isRustEngineAvailable() ? "rust" : "js";
}

export async function runScanToPlan(
  targetDir: string,
  config: SweepConfig,
  options: ScanToPlanOptions & {
    engine?: EngineBackend;
    projectConfig?: SweepConfig;
  } = {},
): Promise<{ result: ScanResult; plan: ScanPlan }> {
  const projectConfig = options.projectConfig ?? DEFAULT_CONFIG;

  if (options.engine === "rust") {
    const blocked = rustScanBlockedReason(config, projectConfig, options);
    if (blocked) {
      console.error(`warning: ${blocked}; using JS engine`);
      const { engine: _engine, projectConfig: _projectConfig, ...scanOptions } = options;
      return scanToPlan(targetDir, config, scanOptions);
    }

    const { engine: _engine, projectConfig: _projectConfig, ...rustOptions } = options;
    const plan = scanToPlanViaRust(targetDir, {
      config,
      selectionPolicy: defaultRustSelectionPolicy(options),
      ...rustOptions,
    });
    return {
      plan,
      result: scanResultFromPlan(plan),
    };
  }

  return scanToPlan(targetDir, config, options);
}

function scanResultFromPlan(plan: ScanPlan): ScanResult {
  return {
    entries: plan.candidates.map((candidate) => ({
      path: candidate.path,
      name: candidate.name,
      estimatedBytes: candidate.estimatedBytes,
      isSymlink: candidate.isSymlink,
      entryType: candidate.entryType,
    })),
    estimatedTotalBytes: plan.summary.estimatedTotalBytes,
    scannedDirs: plan.summary.scannedDirs,
    exact: plan.summary.exact,
  };
}

export function resolveSelectionPolicy(
  opts: Pick<CliOptions, "includeDangerous" | "select">,
): SelectionPolicy {
  const mode = isSelectionMode(opts.select) ? opts.select : "default";
  return {
    mode,
    includeDangerous: opts.includeDangerous ?? false,
  };
}

function isSelectionMode(value: string | undefined): value is SelectionMode {
  return value === "default" || value === "safe" || value === "all" || value === "none";
}

export function isOpenTuiAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve("@opentui/core");
    return true;
  } catch {
    return false;
  }
}

export function assertOpenTuiAvailable(): void {
  if (isOpenTuiAvailable()) return;
  throw new GuardrailError(
    "sweep ui requires @opentui/core. Install it with: npm install @opentui/core",
  );
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Show a [y/N] prompt. Default is NO (empty input → false). */
export function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.on("close", () => resolvePromise(false));

    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolvePromise(normalized === "y" || normalized === "yes");
    });
  });
}

export async function runScanWithDisplay(
  targetDir: string,
  config: SweepConfig,
  options: ScanToPlanOptions & {
    engine?: EngineBackend;
    projectConfig?: SweepConfig;
    spinnerLabel?: string;
    output?: OutputOptions;
  },
): Promise<{ result: ScanResult; plan: ScanPlan }> {
  const { output, spinnerLabel, ...scanOptions } = options;
  const quiet = output?.quiet ?? false;
  const verbose = output?.verbose ?? false;

  if (!quiet) {
    const { printBanner } = await import("@kitsunekode/sweep-display");
    printBanner();
  }

  if (verbose && !quiet) {
    const { createProgressiveScanRenderer } = await import("@kitsunekode/sweep-display");
    const progressive = createProgressiveScanRenderer(spinnerLabel ?? "Scanning...");
    let result: ScanResult;
    let plan: ScanPlan;

    try {
      ({ result, plan } = await runScanToPlan(targetDir, config, {
        ...scanOptions,
        onEntry: () => {
          progressive.stopSpinner();
        },
        onEntrySized: (entry) => {
          const candidate = toCandidate(entry);
          progressive.onCandidate(entry, candidate.riskTier);
        },
      }));
    } finally {
      progressive.stopSpinner();
    }

    progressive.finish({
      scannedDirs: result.scannedDirs,
      count: result.entries.length,
      totalBytes: result.estimatedTotalBytes,
      exact: result.exact,
    });

    return { result, plan };
  }

  const { createSpinner } = await import("@kitsunekode/sweep-display");
  const spinner = quiet ? null : createSpinner(spinnerLabel ?? "Scanning...");

  try {
    const { result, plan } = await runScanToPlan(targetDir, config, {
      ...scanOptions,
      onEntry: () => {
        spinner?.stop();
      },
      onEntrySized: () => {
        spinner?.stop();
      },
    });

    if (!quiet) {
      const { printGroupedScanPlan } = await import("@kitsunekode/sweep-display");
      printGroupedScanPlan(plan, targetDir, output?.verbose ? { verbose: true } : {});
    }

    return { result, plan };
  } finally {
    spinner?.stop();
  }
}

export async function confirmPlanDeletion(
  plan: ScanPlan,
  options: { yes?: boolean },
): Promise<boolean> {
  if (options.yes) return true;

  const { formatBytes } = await import("@kitsunekode/sweep-display");
  const selectedBytes = plan.candidates
    .filter((candidate) => plan.selectedCandidateIds.includes(candidate.id))
    .reduce((sum, candidate) => sum + candidate.estimatedBytes, 0);

  return promptConfirm(
    `Delete ${plan.selectedCandidateIds.length} selected items (~${formatBytes(selectedBytes)})?`,
  );
}

export async function executePlanDeletion(
  plan: ScanPlan,
  engine: EngineBackend,
  options: { quiet?: boolean } = {},
): Promise<{
  report: ApplyReport;
  cleanResult: import("@kitsunekode/sweep-protocol").CleanResult;
}> {
  const selected = plan.candidates.filter((candidate) =>
    plan.selectedCandidateIds.includes(candidate.id),
  );
  const total = selected.length;
  let current = 0;
  let freedBytes = 0;

  const { clearDeletionProgress, printDeletionProgress } =
    await import("@kitsunekode/sweep-display");

  const applyOptions = options.quiet
    ? {}
    : {
        onDeleted: (entry: import("@kitsunekode/sweep-protocol").ScanEntry) => {
          current++;
          freedBytes += entry.estimatedBytes;
          printDeletionProgress(current, total, entry.path, freedBytes);
        },
      };

  const { report, cleanResult } = await applyPlanWithBackend(plan, engine, applyOptions);
  clearDeletionProgress();

  return { report, cleanResult };
}
