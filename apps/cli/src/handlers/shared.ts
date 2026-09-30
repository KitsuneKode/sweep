import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
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
import {
  GuardrailError,
  assertSafeCwd,
  assertSafePattern,
  assertTargetDirectory,
} from "@kitsunekode/sweep-core/guardrails";
import { toCandidate } from "@kitsunekode/sweep-core/planner";
import { appendHistory } from "@kitsunekode/sweep-core/history";
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

/**
 * Resolve a CLI path argument to an absolute path. Shells expand a leading `~`
 * only when unquoted, so a quoted or scripted `"~/x"` would otherwise land on a
 * literal `~` segment and fail with "directory does not exist".
 */
export function resolveTargetPath(pathArg: string): string {
  const expanded =
    pathArg === "~"
      ? homedir()
      : pathArg.startsWith("~/") || pathArg.startsWith(`~${sep}`)
        ? resolve(homedir(), pathArg.slice(2))
        : pathArg;
  return resolve(expanded);
}

/**
 * The standard target preamble shared by every command that takes a path:
 * expand ~, resolve, then assert it is a safe, existing directory.
 */
export function resolveScanTarget(pathArg: string): string {
  const targetDir = resolveTargetPath(pathArg);
  assertSafeCwd(targetDir);
  assertTargetDirectory(targetDir);
  return targetDir;
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
    const plan = await scanToPlanViaRust(targetDir, {
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
      ...(candidate.modifiedMs !== undefined ? { modifiedMs: candidate.modifiedMs } : {}),
      isSymlink: candidate.isSymlink,
      entryType: candidate.entryType,
    })),
    estimatedTotalBytes: plan.summary.estimatedTotalBytes,
    scannedDirs: plan.summary.scannedDirs,
    skippedDirs: plan.summary.skippedDirs ?? 0,
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

    const settle = (value: boolean): void => {
      rl.close();
      resolvePromise(value);
    };

    rl.on("close", () => {
      // Only treat an unexpected close as "declined" when the question was
      // never answered. A normal EOF (e.g. piped `y\n`) still resolves via the
      // question callback above, so this never races the user's answer.
      if (!answered) settle(false);
    });

    let answered = false;
    rl.question(`${question} [y/N] `, (answer) => {
      answered = true;
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
      skippedDirs: result.skippedDirs,
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
  options: { yes?: boolean; trash?: boolean },
): Promise<boolean> {
  if (options.yes) return true;

  const { formatBytes } = await import("@kitsunekode/sweep-display");
  const selectedBytes = plan.candidates
    .filter((candidate) => plan.selectedCandidateIds.includes(candidate.id))
    .reduce((sum, candidate) => sum + candidate.estimatedBytes, 0);

  const dangerousCount = plan.candidates.filter(
    (candidate) =>
      plan.selectedCandidateIds.includes(candidate.id) &&
      (candidate.riskTier === "dangerous" || candidate.riskTier === "blocked"),
  ).length;

  const dangerNote = dangerousCount > 0 ? ` · ${dangerousCount} dangerous` : "";
  const action = options.trash
    ? `Move ${plan.selectedCandidateIds.length} selected items to .sweep-trash`
    : `Delete ${plan.selectedCandidateIds.length} selected items`;
  return promptConfirm(`${action} (~${formatBytes(selectedBytes)})${dangerNote}?`);
}

/**
 * Timestamped trash dir inside the target - keeps moves on the same
 * filesystem so they are atomic renames. Suffix bump on collision.
 */
function freshTrashDir(targetDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let trashDir = join(targetDir, `.sweep-trash-${stamp}`);
  for (let suffix = 2; existsSync(trashDir); suffix++) {
    trashDir = join(targetDir, `.sweep-trash-${stamp}-${suffix}`);
  }
  return trashDir;
}

export async function executePlanDeletion(
  plan: ScanPlan,
  engine: EngineBackend,
  options: { quiet?: boolean; trash?: boolean } = {},
): Promise<{
  report: ApplyReport;
  cleanResult: import("@kitsunekode/sweep-protocol").CleanResult;
  interrupted: boolean;
  /** Absolute trash dir when `--trash` moved entries instead of deleting. */
  trashDir?: string;
}> {
  const selected = plan.candidates.filter((candidate) =>
    plan.selectedCandidateIds.includes(candidate.id),
  );
  // Schema-valid doesn't mean semantically sound - a hand-edited or stale
  // plan can list ids that match no candidate. Surface it instead of
  // silently dropping them.
  const droppedIds = plan.selectedCandidateIds.length - selected.length;
  if (droppedIds > 0 && !options.quiet) {
    console.error(
      `warning: plan lists ${droppedIds} selected id(s) that match no candidate; skipping them`,
    );
  }
  const total = selected.length;
  let current = 0;
  let freedBytes = 0;

  const { clearDeletionProgress, printDeletionProgress } =
    await import("@kitsunekode/sweep-display");

  let effectiveEngine = engine;
  let trashDir: string | undefined;
  if (options.trash) {
    if (engine === "rust") {
      console.error("warning: --trash is not supported by the Rust engine; using JS engine");
      effectiveEngine = "js";
    }
    trashDir = freshTrashDir(plan.targetDir);
    mkdirSync(trashDir, { recursive: true });
  }

  // Ctrl+C during apply must not vanish the report: stop scheduling new
  // deletions, let in-flight rm calls finish, then report the partial state.
  // A second SIGINT (no listener left) force-kills as usual.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);

  const applyOptions = {
    isCancelled: () => controller.signal.aborted,
    signal: controller.signal,
    ...(trashDir ? { trashDir, trashRoot: plan.targetDir } : {}),
    ...(options.quiet
      ? {}
      : {
          onDeleted: (entry: import("@kitsunekode/sweep-protocol").ScanEntry) => {
            current++;
            freedBytes += entry.estimatedBytes;
            printDeletionProgress(current, total, entry.path, entry.estimatedBytes, freedBytes, {
              verb: trashDir ? "moving" : "deleting",
            });
          },
        }),
  };

  try {
    const { report, cleanResult, interrupted } = await applyPlanWithBackend(
      plan,
      effectiveEngine,
      applyOptions,
    );
    // Best-effort - a stats write must never fail an apply.
    appendHistory({
      ts: new Date().toISOString(),
      targetDir: plan.targetDir,
      engine: effectiveEngine,
      deleted: report.deletedCount,
      bytesFreed: report.totalBytesFreed,
      failed: report.failedCount,
      interrupted: interrupted || controller.signal.aborted,
      ...(trashDir ? { trashDir } : {}),
    });
    return {
      report,
      cleanResult,
      interrupted: interrupted || controller.signal.aborted,
      ...(trashDir ? { trashDir } : {}),
    };
  } finally {
    process.removeListener("SIGINT", onSigint);
    clearDeletionProgress();
    if (trashDir) {
      // rmdir only removes an empty dir - when every move failed the trash
      // root is a bare husk; when moves landed it stays.
      try {
        rmdirSync(trashDir);
      } catch {
        // Non-empty or transient error - leave it.
      }
    }
  }
}
