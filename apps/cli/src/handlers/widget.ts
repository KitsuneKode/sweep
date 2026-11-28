import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  REBUILD_COSTS,
  WIDGET_PROGRESS_MIN_INTERVAL_MS,
  WIDGET_SCHEMA_VERSION,
  WIDGET_STALE_MS,
  sanitizeTerminalText,
  type CliOptions,
  type RebuildCost,
  type WidgetError,
  type WidgetEvent,
  type WidgetSnapshot,
  type WidgetView,
} from "@kitsunekode/sweep-protocol";
import { ConfigParseError } from "@kitsunekode/sweep-core/config";
import {
  GuardrailError,
  assertSafeCwd,
  filesystemErrorCode,
  pathUsesProcessRelativeRoot,
} from "@kitsunekode/sweep-core/guardrails";
import { toCandidate } from "@kitsunekode/sweep-core/planner";
import { rebuildFor } from "@kitsunekode/sweep-core/rebuild";
import { probeRustEngine } from "@kitsunekode/sweep-core/rust-engine";
import {
  buildEmptyCacheSnapshot,
  buildWidgetErrorSnapshot,
  buildWidgetSnapshot,
  readRecentWidgetReceipt,
  readWidgetCacheEntry,
  readWidgetDiskInfo,
  widgetErrorForCode,
  writeWidgetCacheEntry,
} from "@kitsunekode/sweep-core/widget";
import { formatBytes, printError } from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError, type ExitCode } from "../errors.js";
import {
  applyNoColor,
  drainStdout,
  resolveEngineBackend,
  resolveProjectScanConfig,
  resolveScanConfig,
  resolveSelectionPolicy,
  resolveTargetPath,
  runScanToPlan,
  waitForStdoutConsumer,
  warnIgnoredOptions,
  writeJson,
  writeJsonLine,
} from "./shared.js";

const DEFAULT_TIMEOUT_LOW_MEMORY_MS = 45_000;
const DEFAULT_TIMEOUT_BALANCED_MS = 120_000;

export interface WidgetCliOptions extends CliOptions {
  view?: WidgetView;
  json?: boolean;
  jsonStream?: boolean;
  cacheOnly?: boolean;
  refresh?: boolean;
  timeout?: number;
  staleAfter?: number;
}

function formatAgeShort(ageMs: number): string {
  if (ageMs < 60_000) return `${Math.max(0, Math.round(ageMs / 1000))}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

function printWidgetSummary(snapshot: WidgetSnapshot): void {
  const safeTarget = sanitizeTerminalText(snapshot.targetDir);
  if (snapshot.error) {
    printError(snapshot.error.message);
    return;
  }
  if (!snapshot.projectsSummary) {
    console.log(`${safeTarget} · no cached scan yet (${snapshot.state})`);
    return;
  }
  const s = snapshot.projectsSummary;
  const ageSuffix =
    snapshot.source === "cache"
      ? ` · cached ${formatAgeShort(snapshot.ageMs)}${snapshot.stale ? " (stale)" : ""}`
      : "";
  const guardedSuffix = s.guardedBytes > 0 ? ` · +${formatBytes(s.guardedBytes)} guarded` : "";
  console.log(
    `${formatBytes(s.reclaimableBytes)} reclaimable in ${safeTarget}${guardedSuffix}${ageSuffix}`,
  );
  if (s.idle.projects > 0) {
    console.log(
      `  ${s.idle.projects} idle project(s) (${s.idle.days}d+): ${formatBytes(s.idle.bytes)}`,
    );
  }
  if (s.worktrees.finished > 0) {
    console.log(
      `  ${s.worktrees.finished} finished worktree(s): ${formatBytes(s.worktrees.bytes)}`,
    );
  }
  if (snapshot.partial && snapshot.skippedDirs > 0) {
    console.log(`  skipped ${snapshot.skippedDirs} unreadable folder(s) · sizes are a lower bound`);
  }
}

async function emitWidgetErrorAndExit(
  targetDir: string,
  error: WidgetError,
  exitCode: ExitCode,
  opts: { json?: boolean | undefined; jsonStream?: boolean | undefined; elapsedMs?: number },
): Promise<never> {
  if (opts.jsonStream) {
    writeJsonLine({
      type: "widget_error",
      widgetSchemaVersion: WIDGET_SCHEMA_VERSION,
      error,
    } satisfies WidgetEvent);
    await drainStdout();
    exitWith(exitCode);
  }
  if (opts.json) {
    writeJson(
      buildWidgetErrorSnapshot(
        targetDir,
        error,
        opts.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : undefined,
      ),
    );
    await drainStdout();
    exitWith(exitCode);
  }
  printError(error.message);
  exitWith(exitCode);
}

/**
 * Resolve and validate the widget target directory.
 *
 * Respects all existing path guardrails (`~`, system roots, shallow paths,
 * VCS directories, process-relative roots) unconditionally, while surfacing
 * missing or unreadable directories as structured `WidgetError` codes for
 * desktop widgets.
 */
function resolveWidgetTarget(
  pathArg: string,
): { ok: true; targetDir: string } | { ok: false; targetDir: string; error: WidgetError } {
  const expanded = resolveTargetPath(pathArg);
  assertSafeCwd(expanded);
  if (pathUsesProcessRelativeRoot(expanded)) {
    throw new GuardrailError("scan target resolves through a process-relative path");
  }

  let stat;
  try {
    stat = statSync(expanded);
  } catch (err) {
    const code = filesystemErrorCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, targetDir: expanded, error: widgetErrorForCode("target_missing") };
    }
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, targetDir: expanded, error: widgetErrorForCode("permission_denied") };
    }
    throw err;
  }

  if (!stat.isDirectory()) {
    throw new GuardrailError(`Target path is not a directory: ${sanitizeTerminalText(expanded)}`);
  }

  try {
    accessSync(expanded, constants.R_OK | constants.X_OK);
  } catch (err) {
    const code = filesystemErrorCode(err);
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, targetDir: expanded, error: widgetErrorForCode("permission_denied") };
    }
    throw err;
  }

  let canonical: string;
  try {
    canonical = realpathSync(expanded);
  } catch (err) {
    const code = filesystemErrorCode(err);
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, targetDir: expanded, error: widgetErrorForCode("permission_denied") };
    }
    if (code === "ENOENT") {
      return { ok: false, targetDir: expanded, error: widgetErrorForCode("target_missing") };
    }
    throw err;
  }

  assertSafeCwd(canonical);
  if (pathUsesProcessRelativeRoot(canonical)) {
    throw new GuardrailError("scan target resolves through a process-relative path");
  }

  return { ok: true, targetDir: canonical };
}

/**
 * `sweep widget` - bounded, strictly read-only summary for desktop widgets
 * (Kuwai island and other panel surfaces). Never deletes, never scans `~` or
 * protected roots, and supports `--cache-only` for zero-scan polling.
 */
export async function handleWidget(pathArg: string, opts: WidgetCliOptions): Promise<void> {
  applyNoColor(opts.color);
  warnIgnoredOptions(opts, "widget", {
    scans: true,
    except: ["--json", "--idle"],
  });

  const startedAt = performance.now();
  let resolvedTargetForError = pathArg;

  try {
    if (opts.json && opts.jsonStream) {
      throw new GuardrailError(
        "Choose one: --json emits a widget snapshot; --json-stream emits NDJSON widget events.",
      );
    }
    if (opts.cacheOnly && opts.refresh) {
      throw new GuardrailError(
        "Choose one: --cache-only reads the cached snapshot without scanning; --refresh forces a live scan.",
      );
    }
    if (opts.cacheOnly && opts.jsonStream) {
      throw new GuardrailError(
        "--cache-only returns an immediate snapshot and cannot be combined with --json-stream.",
      );
    }

    const target = resolveWidgetTarget(pathArg);
    resolvedTargetForError = target.targetDir;
    if (!target.ok) {
      await emitWidgetErrorAndExit(target.targetDir, target.error, EXIT.GUARDRAIL, {
        json: opts.json,
        jsonStream: opts.jsonStream,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    }

    const targetDir = target.targetDir;
    const staleAfterMs = opts.staleAfter ?? WIDGET_STALE_MS;
    const nowMs = Date.now();
    const receipt = readRecentWidgetReceipt(targetDir, { nowMs });

    if (opts.cacheOnly) {
      const cached = readWidgetCacheEntry(targetDir, {
        nowMs,
        staleAfterMs,
        receipt,
      });
      const snapshot =
        cached ??
        buildEmptyCacheSnapshot(targetDir, {
          nowMs,
          disk: readWidgetDiskInfo(targetDir),
          receipt,
        });
      if (opts.json) writeJson(snapshot);
      else printWidgetSummary(snapshot);
      await drainStdout();
      exitWith(EXIT.OK);
    }

    const config = resolveScanConfig(targetDir, opts);
    const projectConfig = resolveProjectScanConfig(targetDir, opts);
    const selectionPolicy = resolveSelectionPolicy(opts);
    const resourceProfile = opts.resourceProfile ?? "low-memory";

    if (opts.engine === "rust" && !probeRustEngine().available) {
      await emitWidgetErrorAndExit(targetDir, widgetErrorForCode("engine_missing"), EXIT.FAILURE, {
        json: opts.json,
        jsonStream: opts.jsonStream,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    }

    const engine = resolveEngineBackend(opts, {
      warnOnFallback: !opts.json && !opts.jsonStream,
    });

    const timeoutMs =
      opts.timeout ??
      (resourceProfile === "low-memory"
        ? DEFAULT_TIMEOUT_LOW_MEMORY_MS
        : DEFAULT_TIMEOUT_BALANCED_MS);

    const controller = new AbortController();
    let timedOut = false;
    let signalCancelled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("widget scan timed out"));
    }, timeoutMs);
    timer.unref?.();

    const onSignal = () => {
      signalCancelled = true;
      controller.abort(new Error("widget scan interrupted"));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    try {
      if (opts.jsonStream) {
        writeJsonLine({
          type: "widget_started",
          widgetSchemaVersion: WIDGET_SCHEMA_VERSION,
          view: "projects",
          targetDir,
          startedAt: new Date().toISOString(),
        } satisfies WidgetEvent);

        const candidateStates = new Map<
          string,
          { cost: RebuildCost; bytes: number; reclaimable: boolean }
        >();
        const costBytes = new Map<RebuildCost, number>();
        let estimatedBytes = 0;
        let sizedCount = 0;
        let lastScannedDirs = 0;
        let lastFound = 0;
        let lastCurrentDir: string | undefined;
        let lastProgressEmitMs = 0;

        const emitProgress = (force = false) => {
          const now = performance.now();
          if (!force && now - lastProgressEmitMs < WIDGET_PROGRESS_MIN_INTERVAL_MS) return;
          lastProgressEmitMs = now;
          const byCost: { cost: RebuildCost; bytes: number }[] = [];
          for (const cost of REBUILD_COSTS) {
            const bytes = costBytes.get(cost) ?? 0;
            if (bytes > 0) byCost.push({ cost, bytes });
          }
          writeJsonLine({
            type: "widget_progress",
            widgetSchemaVersion: WIDGET_SCHEMA_VERSION,
            view: "projects",
            scannedDirs: lastScannedDirs,
            found: lastFound,
            sizedCount,
            estimatedBytes,
            ...(lastCurrentDir ? { currentDir: sanitizeTerminalText(lastCurrentDir) } : {}),
            byCost,
          } satisfies WidgetEvent);
        };

        const trackEntry = (entry: Parameters<typeof toCandidate>[0], sized: boolean) => {
          const candidate = toCandidate(entry);
          const reclaimable = candidate.riskTier === "safe" || candidate.riskTier === "caution";
          const ownerRoot = candidate.projectRoot ?? dirname(candidate.path);
          const cost = rebuildFor(candidate.kind, ownerRoot, candidate.name).cost;
          const nextBytes = reclaimable
            ? Math.max(0, Math.trunc(candidate.estimatedBytes || 0))
            : 0;

          const prev = candidateStates.get(candidate.id);
          if (prev) {
            if (prev.reclaimable) {
              estimatedBytes -= prev.bytes;
              costBytes.set(prev.cost, (costBytes.get(prev.cost) ?? 0) - prev.bytes);
            }
          }
          if (reclaimable) {
            estimatedBytes += nextBytes;
            costBytes.set(cost, (costBytes.get(cost) ?? 0) + nextBytes);
          }
          candidateStates.set(candidate.id, { cost, bytes: nextBytes, reclaimable });
          if (sized) {
            sizedCount += 1;
          }
          lastFound = Math.max(lastFound, candidateStates.size);
          emitProgress();
        };

        const { plan } = await runScanToPlan(targetDir, config, {
          exact: false,
          waitForConsumer: waitForStdoutConsumer,
          selectionPolicy,
          ...(opts.idle !== undefined ? { idleMs: opts.idle } : {}),
          engine,
          projectConfig,
          resourceProfile,
          signal: controller.signal,
          onProgress: (progress) => {
            lastScannedDirs = progress.scannedDirs;
            lastFound = Math.max(lastFound, progress.found);
            if (progress.sizedCount !== undefined) sizedCount = progress.sizedCount;
            if (progress.currentDir !== undefined) lastCurrentDir = progress.currentDir;
            emitProgress();
          },
          onEntry: (entry) => trackEntry(entry, false),
          onEntrySized: (entry) => trackEntry(entry, true),
        });

        const snapshot = buildWidgetSnapshot(plan, {
          nowMs: Date.now(),
          elapsedMs: Math.round(performance.now() - startedAt),
          ...(opts.idle !== undefined ? { idleWindowMs: opts.idle } : {}),
          disk: readWidgetDiskInfo(targetDir),
          receipt: readRecentWidgetReceipt(targetDir),
          source: "live",
          staleAfterMs,
        });
        writeWidgetCacheEntry(snapshot);
        writeJsonLine({
          type: "widget_snapshot",
          widgetSchemaVersion: WIDGET_SCHEMA_VERSION,
          snapshot,
        } satisfies WidgetEvent);
        await drainStdout();
        exitWith(EXIT.OK);
      }

      const { plan } = await runScanToPlan(targetDir, config, {
        selectionPolicy,
        ...(opts.idle !== undefined ? { idleMs: opts.idle } : {}),
        engine,
        projectConfig,
        resourceProfile,
        signal: controller.signal,
      });

      const snapshot = buildWidgetSnapshot(plan, {
        nowMs: Date.now(),
        elapsedMs: Math.round(performance.now() - startedAt),
        ...(opts.idle !== undefined ? { idleWindowMs: opts.idle } : {}),
        disk: readWidgetDiskInfo(targetDir),
        receipt: readRecentWidgetReceipt(targetDir),
        source: "live",
        staleAfterMs,
      });
      writeWidgetCacheEntry(snapshot);

      if (opts.json) writeJson(snapshot);
      else printWidgetSummary(snapshot);
      await drainStdout();
      exitWith(EXIT.OK);
    } catch (err) {
      if (timedOut) {
        await emitWidgetErrorAndExit(targetDir, widgetErrorForCode("timeout"), EXIT.FAILURE, {
          json: opts.json,
          jsonStream: opts.jsonStream,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
      }
      if (signalCancelled) {
        exitWith(EXIT.ABORTED);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  } catch (err) {
    if (err instanceof GuardrailError || err instanceof ConfigParseError) {
      handleFatalError(err, { json: opts.json || opts.jsonStream });
    }
    const code = filesystemErrorCode(err);
    const widgetErr =
      code === "EACCES" || code === "EPERM"
        ? widgetErrorForCode("permission_denied")
        : code === "ENOENT"
          ? widgetErrorForCode("target_missing")
          : widgetErrorForCode("scan_failed");
    const exitCode =
      widgetErr.code === "permission_denied" || widgetErr.code === "target_missing"
        ? EXIT.GUARDRAIL
        : EXIT.FAILURE;
    await emitWidgetErrorAndExit(resolvedTargetForError, widgetErr, exitCode, {
      json: opts.json,
      jsonStream: opts.jsonStream,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  }
}
