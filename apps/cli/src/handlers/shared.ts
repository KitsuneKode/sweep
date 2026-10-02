import { existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type {
  ApplyReport,
  CliOptions,
  ScanPlan,
  ScanResult,
  SelectionMode,
  SelectionPolicy,
  SweepConfig,
} from "@kitsunekode/sweep-protocol";
import { isColdRequested, tryDropPageCache } from "@kitsunekode/sweep-core/cold";
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
  isSameResolvedPath,
} from "@kitsunekode/sweep-core/guardrails";
import { resolveSelectedCandidates, toCandidate } from "@kitsunekode/sweep-core/planner";
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
    // Only forward depth when the user actually passed it - a defaulted flag
    // must not shadow the project/global config layer.
    ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
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

/**
 * Warn when a command parses global flags it never acts on.
 *
 * Every program-level option parses on every subcommand, so without this a
 * `sweep apply --pattern x` or `sweep stats --dry-run` silently drops user
 * intent - the worst failure mode for a trust-first tool. The `shape` flags
 * name which groups the command honors; `except` subtracts individual flags
 * the command reads only partially.
 */
export function warnIgnoredOptions(
  opts: CliOptions & { trash?: boolean; json?: boolean },
  command: string,
  shape: { scans?: boolean; applies?: boolean; structured?: boolean; except?: string[] } = {},
): void {
  const ignored = new Set<string>();
  if (!shape.scans) {
    if ((opts.pattern ?? []).length > 0) ignored.add("--pattern");
    if ((opts.ignore ?? []).length > 0) ignored.add("--ignore");
    if ((opts.disabledPattern ?? []).length > 0) ignored.add("--disabled-pattern");
    if (opts.depth !== undefined) ignored.add("--depth");
    if (opts.select !== undefined && opts.select !== "default") ignored.add("--select");
    if (opts.includeDangerous) ignored.add("--include-dangerous");
    if (opts.cold) ignored.add("--cold");
  }
  if (!shape.applies) {
    if (opts.yes) ignored.add("--yes");
    if (opts.trash) ignored.add("--trash");
    if (opts.forceLarge) ignored.add("--force-large");
    if (opts.dryRun) ignored.add("--dry-run");
  }
  if (!shape.structured) {
    if (opts.json) ignored.add("--json");
    if (opts.quiet) ignored.add("--quiet");
    if (opts.verbose) ignored.add("--verbose");
  }
  for (const flag of shape.except ?? []) ignored.delete(flag);
  if (ignored.size === 0) return;
  const list = [...ignored].sort().join(", ");
  console.error(
    `warning: ${list} ${ignored.size === 1 ? "has" : "have"} no effect on \`sweep ${command}\``,
  );
}

export async function runScanToPlan(
  targetDir: string,
  config: SweepConfig,
  options: ScanToPlanOptions & {
    engine?: EngineBackend;
    projectConfig?: SweepConfig;
  } = {},
): Promise<{ result: ScanResult; plan: ScanPlan; engineUsed: "js" | "rust" }> {
  // --cold/SWEEP_COLD: pay the cold costs a fresh user pays. The probe memo
  // bypass lives at the probe itself; here we drop what the OS lets us and
  // say so when it lets us drop nothing.
  if (isColdRequested()) {
    const drop = tryDropPageCache();
    if (!drop.dropped) {
      console.error(`note: cold run - ${drop.detail}; timings may still hit warm cache`);
    }
  }

  const projectConfig = options.projectConfig ?? DEFAULT_CONFIG;

  if (options.engine === "rust") {
    const blocked = rustScanBlockedReason(config, projectConfig, options);
    if (blocked) {
      console.error(`warning: ${blocked}; using JS engine`);
      const { engine: _engine, projectConfig: _projectConfig, ...scanOptions } = options;
      const { result, plan } = await scanToPlan(targetDir, config, scanOptions);
      return { result, plan, engineUsed: "js" };
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
      engineUsed: "rust",
    };
  }

  const { result, plan } = await scanToPlan(targetDir, config, options);
  return { result, plan, engineUsed: "js" };
}

function scanResultFromPlan(plan: ScanPlan): ScanResult {
  return {
    entries: plan.candidates.map((candidate) => ({
      path: candidate.path,
      name: candidate.name,
      estimatedBytes: candidate.estimatedBytes,
      ...(candidate.modifiedMs !== undefined ? { modifiedMs: candidate.modifiedMs } : {}),
      // bytesKnown:false marks a lower-bound size - dropping it would let an
      // undercounted entry present as exact downstream.
      ...(candidate.bytesKnown !== undefined ? { bytesKnown: candidate.bytesKnown } : {}),
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

/**
 * Show a [y/N] prompt. Default is NO (empty input → false).
 * The question goes to stderr: stdout is reserved for results so `--json`
 * consumers never see prompt text, and a piped stdin still hits EOF→decline.
 */
export function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
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
  const startedAt = performance.now();

  if (!quiet) {
    const { printBanner } = await import("@kitsunekode/sweep-display");
    printBanner();
  }

  if (verbose && !quiet) {
    const { createProgressiveScanRenderer } = await import("@kitsunekode/sweep-display");
    const progressive = createProgressiveScanRenderer(spinnerLabel ?? "Scanning...");
    let result: ScanResult;
    let plan: ScanPlan;
    let engineUsed: "js" | "rust" = "js";

    try {
      ({ result, plan, engineUsed } = await runScanToPlan(targetDir, config, {
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
      engine: engineUsed,
      elapsedMs: Math.round(performance.now() - startedAt),
    });

    return { result, plan };
  }

  const { createSpinner } = await import("@kitsunekode/sweep-display");
  const spinner = quiet ? null : createSpinner(spinnerLabel ?? "Scanning...");

  try {
    const { result, plan, engineUsed } = await runScanToPlan(targetDir, config, {
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
      printGroupedScanPlan(plan, targetDir, {
        ...(output?.verbose ? { verbose: true } : {}),
        elapsedMs: Math.round(performance.now() - startedAt),
        engine: engineUsed,
      });
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
  const selectedIds = new Set(plan.selectedCandidateIds);
  const selectedBytes = plan.candidates
    .filter((candidate) => selectedIds.has(candidate.id))
    .reduce((sum, candidate) => sum + candidate.estimatedBytes, 0);

  const dangerousCount = plan.candidates.filter(
    (candidate) =>
      selectedIds.has(candidate.id) &&
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
  options: {
    quiet?: boolean;
    trash?: boolean;
    maxSizeGB?: number;
    forceLarge?: boolean;
    /** External cancel (in-session TUI apply): stops scheduling like SIGINT. */
    signal?: AbortSignal;
  } = {},
): Promise<{
  report: ApplyReport;
  cleanResult: import("@kitsunekode/sweep-protocol").CleanResult;
  interrupted: boolean;
  /** Absolute trash dir when `--trash` moved entries instead of deleting. */
  trashDir?: string;
}> {
  // Re-assert the target guardrail here - not just in callers - so the trash
  // mkdir below can never run against a root a forged plan would fail on.
  assertSafeCwd(plan.targetDir);
  // Validate identity before creating trash directories or painting progress.
  const selected = resolveSelectedCandidates(plan);
  const total = selected.length;
  let current = 0;
  let freedBytes = 0;
  let activePath: string | undefined;
  let activeBytes = 0;
  const startedAt = Date.now();

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
    // Pin the trash root's identity before any move touches it: a watcher
    // could have swapped the fresh directory for a symlink between existsSync
    // and mkdir - every rename would then land outside the target.
    const trashStat = lstatSync(trashDir);
    const realTrash = realpathSync(trashDir);
    const realTarget = realpathSync(plan.targetDir);
    if (
      trashStat.isSymbolicLink() ||
      !isSameResolvedPath(realTrash, join(realTarget, basename(trashDir)))
    ) {
      throw new GuardrailError(
        `trash directory ${trashDir} is not a real directory inside the target`,
      );
    }
  }

  // Ctrl+C during apply must not vanish the report: stop scheduling new
  // deletions, let in-flight rm calls finish, then report the partial state.
  // A second SIGINT (no listener left) force-kills as usual. An external
  // signal (the TUI's in-session apply) stops scheduling the same way.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  options.signal?.addEventListener("abort", onSigint, { once: true });
  // addEventListener on an already-aborted signal never fires - a ctrl-c
  // that landed during the import/trash setup above would be silently
  // dropped without this check.
  if (options.signal?.aborted) onSigint();

  const verb = trashDir ? "moving" : "deleting";
  const paintDeletion = () => {
    printDeletionProgress(current, total, activePath, activeBytes, freedBytes, {
      verb,
      elapsedMs: Date.now() - startedAt,
    });
  };
  // A long directory removal used to sit on a frozen line until it finished.
  // Repaint on a short interval so the elapsed time moves while that one
  // path is in flight. Non-TTY logs stay one line per finished item.
  const progressTimer =
    options.quiet || !process.stdout.isTTY ? undefined : setInterval(paintDeletion, 400);
  progressTimer?.unref();

  const applyOptions = {
    ...(options.maxSizeGB === undefined ? {} : { maxSizeGB: options.maxSizeGB }),
    ...(options.forceLarge === undefined ? {} : { forceLarge: options.forceLarge }),
    isCancelled: () => controller.signal.aborted,
    signal: controller.signal,
    ...(trashDir ? { trashDir, trashRoot: plan.targetDir } : {}),
    ...(options.quiet
      ? {}
      : {
          onBegin: (entry: import("@kitsunekode/sweep-protocol").ScanEntry) => {
            activePath = entry.path;
            activeBytes = entry.estimatedBytes;
            if (process.stdout.isTTY) paintDeletion();
          },
          onDeleted: (entry: import("@kitsunekode/sweep-protocol").ScanEntry) => {
            current++;
            freedBytes += entry.estimatedBytes;
            activePath = entry.path;
            activeBytes = entry.estimatedBytes;
            paintDeletion();
          },
        }),
  };

  if (!options.quiet && total > 0 && process.stdout.isTTY) paintDeletion();

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
    if (progressTimer) clearInterval(progressTimer);
    process.removeListener("SIGINT", onSigint);
    options.signal?.removeEventListener("abort", onSigint);
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
