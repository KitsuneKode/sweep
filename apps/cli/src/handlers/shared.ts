import { assertPlanResources } from "@kitsunekode/sweep-core/plan";
import { noteApplyBackendEntered, noteApplyReportTrusted } from "../apply-lifecycle.js";
import { beginApplySession, type ApplySession } from "@kitsunekode/sweep-core/apply-session";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type {
  ApplyProgress,
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
  assertSizeLimit,
  isApplyRefusedError,
  ApplyRefusedError,
  assertSafePattern,
  assertTargetDirectory,
  isSameResolvedPath,
  pathUsesProcessRelativeRoot,
} from "@kitsunekode/sweep-core/guardrails";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { resolveSelectedCandidates, toCandidate } from "@kitsunekode/sweep-core/planner";
import { appendHistory } from "@kitsunekode/sweep-core/history";
import {
  scanToPlanViaRust,
  isRustEngineAvailable,
  rustScanBlockedReason,
  defaultRustSelectionPolicy,
  type EngineBackend,
} from "@kitsunekode/sweep-core/rust-engine";
import { JsonOutput } from "../json-output.js";
import { setActiveApply } from "../apply-lifecycle.js";

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
  if (pathUsesProcessRelativeRoot(targetDir)) {
    throw new GuardrailError("scan target resolves through a process-relative path");
  }
  // Review, serialize and apply the same real target. A leaf symlink is a
  // valid CLI spelling, but must not become an unappliable saved plan.
  const canonical = realpathSync(targetDir);
  assertSafeCwd(canonical);
  assertTargetDirectory(canonical);
  return canonical;
}

/** Config-layer warnings go to stderr - stdout stays machine-readable. */
const warnConfig = (message: string): void => {
  console.error(`warning: ${sanitizeTerminalText(message)}`);
};

export function resolveScanConfig(targetDir: string, opts: CliOptions): SweepConfig {
  const patterns = opts.pattern ?? [];
  const disabledPatterns = opts.disabledPattern ?? [];
  const ignore = opts.ignore ?? [];

  for (const pattern of patterns) assertSafePattern(pattern);
  for (const pattern of disabledPatterns) assertSafePattern(pattern);
  for (const pattern of ignore) assertSafePattern(pattern);

  const cliOverrides: Partial<SweepConfig> = {
    ...(opts.maxSizeGb === undefined
      ? {}
      : { maxSizeGB: opts.maxSizeGb === "none" ? null : opts.maxSizeGb }),
    // Only forward depth when the user actually passed it - a defaulted flag
    // must not shadow the project/global config layer.
    ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
    ...(patterns.length > 0 ? { patterns } : {}),
    ...(disabledPatterns.length > 0 ? { disabledPatterns } : {}),
    ...(ignore.length > 0 ? { ignore } : {}),
  };

  return loadConfig(targetDir, opts.config, cliOverrides, warnConfig);
}

/** Config from project files only (no CLI pattern/ignore/depth overrides). */
export function resolveProjectScanConfig(targetDir: string, opts: CliOptions): SweepConfig {
  return loadConfig(targetDir, opts.config, {}, warnConfig);
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
    if (opts.config) ignored.add("--config");
    if ((opts.pattern ?? []).length > 0) ignored.add("--pattern");
    if ((opts.ignore ?? []).length > 0) ignored.add("--ignore");
    if ((opts.disabledPattern ?? []).length > 0) ignored.add("--disabled-pattern");
    if (opts.depth !== undefined) ignored.add("--depth");
    if (opts.select !== undefined && opts.select !== "default") ignored.add("--select");
    if (opts.includeDangerous) ignored.add("--include-dangerous");
    if (opts.cold) ignored.add("--cold");
    if (opts.resourceProfile && opts.resourceProfile !== "balanced")
      ignored.add("--resource-profile");
  }
  if (!shape.scans && !shape.applies && opts.engine && opts.engine !== "auto")
    ignored.add("--engine");
  if (!shape.applies) {
    if (opts.maxSizeGb !== undefined) ignored.add("--max-size-gb");
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
    targetIdentity: plan.targetIdentity,
    entries: plan.candidates.map((candidate) => ({
      identity: candidate.identity,
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

let jsonOutput: JsonOutput | undefined;
const output = () => (jsonOutput ??= new JsonOutput(process.stdout));

export function writeJson(value: unknown): void {
  output().write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonLine(value: unknown): void {
  output().write(`${JSON.stringify(value)}\n`);
}

export function waitForStdoutConsumer(): Promise<void> | undefined {
  return output().waitForConsumer();
}

/** Fail explicitly on a closed/stalled pipe rather than exiting with truncated JSON. */
export async function drainStdout(): Promise<void> {
  await output().flush();
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
  // Show where the deletion actually lands: a symlinked-ancestor spelling is
  // legal in a real plan, but the user deserves to see the resolved truth -
  // and a forged spelling can't hide behind what it resolves to.
  const resolvedTarget = (() => {
    try {
      return realpathSync(plan.targetDir);
    } catch {
      return plan.targetDir;
    }
  })();
  const targetDisplay =
    resolvedTarget === plan.targetDir
      ? sanitizeTerminalText(plan.targetDir)
      : `${sanitizeTerminalText(plan.targetDir)} → ${sanitizeTerminalText(resolvedTarget)}`;
  return promptConfirm(
    `${action} in ${targetDisplay} (~${formatBytes(selectedBytes)})${dangerNote}?`,
  );
}

/**
 * Timestamped trash dir inside the target - keeps moves on the same
 * filesystem so they are atomic renames. Suffix bump on collision.
 */
function freshTrashDir(targetDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Atomic mkdir is the reservation: a UUID avoids the exists-then-mkdir race.
  for (let attempt = 0; attempt < 8; attempt++) {
    const trashDir = join(targetDir, `.sweep-trash-${stamp}-${randomUUID()}`);
    try {
      mkdirSync(trashDir, { mode: 0o700 });
      return trashDir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new GuardrailError("Unable to reserve a unique trash directory; nothing removed");
}

export async function executePlanDeletion(
  plan: ScanPlan,
  engine: EngineBackend,
  options: {
    quiet?: boolean;
    trash?: boolean;
    maxSizeGB?: number | null;
    forceLarge?: boolean;
    /** External cancel (in-session TUI apply): stops scheduling like SIGINT. */
    signal?: AbortSignal;
    onProgress?: (progress: ApplyProgress) => void;
  } = {},
): Promise<{
  report: ApplyReport;
  cleanResult: import("@kitsunekode/sweep-protocol").CleanResult;
  interrupted: boolean;
  /** Absolute trash dir when `--trash` moved entries instead of deleting. */
  trashDir?: string;
}> {
  // A resource refusal precedes trash creation, journaling and backend entry.
  try {
    assertPlanResources(plan);
  } catch (error) {
    if (error instanceof GuardrailError)
      throw new ApplyRefusedError(error.message, "resource_limit_exceeded");
    throw error;
  }
  // Re-assert the target guardrail here - not just in callers - so the trash
  // mkdir below can never run against a root a forged plan would fail on.
  assertSafeCwd(plan.targetDir);
  // A plan's target leaf must be a REAL directory: both scanners refuse
  // leaf-symlink roots, so a plan carrying one is forged input. This is the
  // /proc/self/cwd class - canonicalized it resolves to wherever the victim
  // ran sweep, and every downstream containment check then passes under the
  // resolved path. lstat, not stat: stat follows the link.
  if (pathUsesProcessRelativeRoot(plan.targetDir)) {
    throw new GuardrailError("plan target resolves through a process-relative path");
  }
  const targetLeaf = lstatSync(plan.targetDir);
  if (targetLeaf.isSymbolicLink() || !targetLeaf.isDirectory()) {
    throw new GuardrailError(
      `plan target is not a real directory: ${sanitizeTerminalText(plan.targetDir)}`,
    );
  }
  // Validate identity before creating trash directories or painting progress.
  const selected = resolveSelectedCandidates(plan);
  // Refuse an obviously over-limit selection before creating trash or arming
  // a journal. The backend still re-measures before the first removal.
  if (options.maxSizeGB !== undefined) {
    assertSizeLimit(
      selected.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
      options.maxSizeGB,
      options.forceLarge ?? false,
    );
  }
  const total = selected.length;
  let current = 0;
  let freedBytes = 0;
  let activePath: string | undefined;
  let activeBytes = 0;
  let preparation: Pick<ApplyProgress, "preparedCount" | "preparingCount" | "preparationPhase"> =
    {};
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
    // Non-recursive on purpose: the parent IS the targetDir we just
    // revalidated. `recursive: true` would silently resurrect a targetDir
    // that vanished between plan validation and here.
    // freshTrashDir reserved the directory atomically.
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
  // SIGTERM/SIGHUP/SIGQUIT route through the same abort - a terminal closing
  // or `kill` must not orphan a mid-flight delete with no history written.
  // Once any terminating signal fires, ALL listeners come off: a second one
  // force-kills with its default disposition, preserving the escape hatch.
  const TERMINATING = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
  const controller = new AbortController();
  const onTerminating = () => {
    for (const signal of TERMINATING) process.removeListener(signal, onTerminating);
    controller.abort();
  };
  for (const signal of TERMINATING) process.once(signal, onTerminating);
  options.signal?.addEventListener("abort", onTerminating, { once: true });
  // addEventListener on an already-aborted signal never fires - a ctrl-c
  // that landed during the import/trash setup above would be silently
  // dropped without this check.
  if (options.signal?.aborted) onTerminating();

  const verb = trashDir ? "moving" : "deleting";
  let applyStarted = false;
  let removedEntries: number | undefined;
  let lastProgressAt = -Infinity;
  let lastStage: ApplyProgress["stage"] | undefined;
  const paintDeletion = (paintTerminal = true) => {
    const now = Date.now();
    const stage = controller.signal.aborted ? "stopping" : applyStarted ? "applying" : "preparing";
    try {
      if (now - lastProgressAt >= 60 || stage !== lastStage) {
        lastProgressAt = now;
        lastStage = stage;
        options.onProgress?.({
          stage,
          selectedCount: total,
          deletedCount: current,
          estimatedBytesFreed: freedBytes,
          elapsedMs: Date.now() - startedAt,
          ...preparation,
          ...(activePath ? { activePath } : {}),
          ...(removedEntries === undefined ? {} : { removedEntries }),
        });
      }
    } catch {
      // Feedback is best effort; a display callback must not change outcomes.
    }
    if (options.quiet || !paintTerminal) return;
    try {
      printDeletionProgress(current, total, activePath, activeBytes, freedBytes, {
        verb,
        elapsedMs: Date.now() - startedAt,
      });
    } catch {
      // A broken display sink (dead pty, EPIPE mid-write) must never abort
      // the delete loop - the operation's outcome is what matters.
    }
  };
  // A long directory removal used to sit on a frozen line until it finished.
  // Repaint on a short interval so the elapsed time moves while that one
  // path is in flight. Non-TTY logs stay one line per finished item.
  const progressTimer =
    options.onProgress || (!options.quiet && process.stderr.isTTY)
      ? setInterval(paintDeletion, 400)
      : undefined;
  progressTimer?.unref();

  const applyOptions = {
    ...(options.maxSizeGB === undefined ? {} : { maxSizeGB: options.maxSizeGB }),
    ...(options.forceLarge === undefined ? {} : { forceLarge: options.forceLarge }),
    isCancelled: () => controller.signal.aborted,
    signal: controller.signal,
    ...(trashDir ? { trashDir, trashRoot: plan.targetDir } : {}),
    onPrepare: (
      entry: import("@kitsunekode/sweep-protocol").ScanEntry,
      completed: number,
      total: number,
      phase: "validating" | "sizing",
    ) => {
      activePath = entry.path;
      if (preparation.preparationPhase !== phase) lastProgressAt = -Infinity;
      preparation = { preparedCount: completed, preparingCount: total, preparationPhase: phase };
      paintDeletion(Boolean(process.stderr.isTTY));
    },
    onBegin: (entry: import("@kitsunekode/sweep-protocol").ScanEntry) => {
      removedEntries = undefined;
      applyStarted = true;
      activePath = entry.path;
      activeBytes = entry.estimatedBytes;
      paintDeletion(Boolean(process.stderr.isTTY));
    },
    onDeleted: (entry: import("@kitsunekode/sweep-protocol").ScanEntry) => {
      removedEntries = undefined;
      current++;
      freedBytes += entry.estimatedBytes;
      activePath = undefined;
      activeBytes = 0;
      paintDeletion();
    },
    onActivity: (entry: import("@kitsunekode/sweep-protocol").ScanEntry, count: number) => {
      if (activePath !== entry.path) return;
      removedEntries = count;
      paintDeletion(false);
    },
  };

  if (options.onProgress || process.stderr.isTTY) paintDeletion();

  // Register the in-flight apply so bin.ts's EPIPE handler aborts it instead
  // of exiting 0 on a dead stdout.
  setActiveApply(controller);
  let session: ApplySession | undefined;
  try {
    session = beginApplySession(plan, effectiveEngine, trashDir);
    noteApplyBackendEntered();
    const { report, cleanResult, interrupted } = await applyPlanWithBackend(
      plan,
      effectiveEngine,
      applyOptions,
    );
    noteApplyReportTrusted();
    try {
      session.finish(report);
    } catch (error) {
      warnConfig(
        `Apply finished but its journal could not be committed: ${session.journalPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
  } catch (error) {
    if (session && isApplyRefusedError(error)) {
      noteApplyReportTrusted();
      try {
        session.finish({
          protocolVersion: plan.protocolVersion,
          targetDir: plan.targetDir,
          selectedCandidateIds: selected.map((candidate) => candidate.id),
          deletedCount: 0,
          failedCount: 0,
          totalBytesFreed: 0,
          failedPaths: [],
          outcomes: selected.map((candidate) => ({
            candidateId: candidate.id,
            status: "unattempted" as const,
          })),
          interrupted: false,
        });
      } catch (journalError) {
        warnConfig(
          `Could not record apply refusal: ${session.journalPath}: ${String(journalError)}`,
        );
      }
    }
    throw error;
  } finally {
    session?.close();
    setActiveApply(undefined);
    if (progressTimer) clearInterval(progressTimer);
    for (const signal of TERMINATING) process.removeListener(signal, onTerminating);
    options.signal?.removeEventListener("abort", onTerminating);
    if (!options.quiet) clearDeletionProgress();
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
