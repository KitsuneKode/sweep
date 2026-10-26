import { isColdRequested, tryDropPageCache } from "@kitsunekode/sweep-core/cold";
import { buildRescanConfig, sweepConfigDir } from "@kitsunekode/sweep-core/config";
import { resolve } from "node:path";
import {
  loadViewPreferences,
  saveViewPreferences,
  type ViewPreferences,
} from "./view-preferences.js";
import { buildPlan, candidateFromEntry } from "@kitsunekode/sweep-core/planner";
import { isRustEngineAvailable } from "@kitsunekode/sweep-core/rust-engine";
import { scan } from "@kitsunekode/sweep-core/scanner";
import type {
  ScanCandidate,
  ScanEntry,
  ScanPlan,
  SelectionPolicy,
  SweepConfig,
} from "@kitsunekode/sweep-protocol";
import { PROTOCOL_VERSION, sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { readHistory } from "@kitsunekode/sweep-core/history";
import { SweepApp, UiErrorBoundary } from "./app.js";
import {
  discoverJumpTargets,
  tildePath,
  type JumpTarget,
  type RecentClean,
} from "./folder-jump.js";
import type { SweepUiOutcome, UiApplyResult, UiApplyRequest, UiApplyFn } from "./outcome.js";
import { openUiSession } from "./runtime.js";
import type { SweepUiInitOptions } from "./state.js";
import { StreamBatcher, scanBatchCap } from "./stream-batcher.js";

export interface UiScanProgress {
  scannedDirs: number;
  skippedDirs: number;
  currentDir?: string;
  /** Unique artifacts whose size has resolved, including empty artifacts. */
  sizedCount?: number;
}

/** Callbacks the app registers for one scan generation. */
export interface UiScanHooks {
  /** Candidates discovered or resized since the last flush. */
  onBatch: (candidates: ScanCandidate[]) => void;
  onProgress?: (meta: UiScanProgress) => void;
  /** Receipt for the preceding callbacks after React commits their frame.
   * Cancellation/unmount must release it so a stopped generation can finish. */
  waitForCommit?: () => Promise<void>;
  /**
   * Scan finished. `plan` is the authoritative enriched result - the same
   * `buildPlan` output a non-streaming run produces, so workspace stubs and
   * symlink aliases are marked and `selectedCandidateIds` reflects policy.
   */
  onDone: (meta: { scannedDirs: number; skippedDirs: number; plan?: ScanPlan }) => void;
  onError: (error: unknown) => void;
}

/** Live-scan control handed to the app; every call starts a new generation. */
export interface UiScanControl {
  applyPolicy?: { maxSizeGB: number | null; forceLarge: boolean };
  /**
   * Runs one scan generation to completion (or abort). Errors funnel to
   * `hooks.onError` rather than rejecting, but it is async all the same -
   * callers must not treat the return as "the scan is done".
   */
  start(hooks: UiScanHooks, signal: AbortSignal): Promise<void>;
  /** Push pattern-editor changes so the next rescan uses them. */
  syncPatterns(disabledPatterns: string[], extraPatterns: string[]): void;
  /**
   * Switch the backend the next `start` uses (E in the TUI - flip between
   * `js` and `rust` to compare engines on the same tree). Returns false when
   * the requested engine isn't runnable (rust binary missing), leaving the
   * current selection untouched.
   */
  setEngine(engine: "js" | "rust"): boolean;
  /**
   * Apply a scoped plan without leaving the session (queued or single-row `x`). Runs
   * on the engine `E` last selected; absent when the host provides no apply
   * channel (static plans, tests) - the app falls back to an exit-apply.
   */
  apply?: (request: Omit<UiApplyRequest, "engine">) => Promise<UiApplyResult>;
}

export interface SweepUiStreamingOptions {
  targetDir: string;
  /** Resolved scan config (patterns/ignore/depth/maxSizeGB). */
  config: SweepConfig;
  selectionPolicy: SelectionPolicy;
  engine: "js" | "rust";
  forceLarge?: boolean;
  resourceProfile?: import("@kitsunekode/sweep-protocol").ResourceProfile | undefined;
  dryRun?: boolean;
  /** Trash mode - the apply dialog says "move" and a TRASH chip shows. */
  trash?: boolean;
  /**
   * In-session apply channel - the host runs the engine's apply with the
   * same revalidation/containment/history as an exit apply. The `engine`
   * argument follows the E toggle so a flipped scan engine applies too.
   */
  apply?: UiApplyFn;
  init?: SweepUiInitOptions;
  /**
   * Re-run the host's target resolution for a folder picked in the session
   * (ctrl-o): the same guardrails and `.sweeprc` lookup as a fresh `sweep ui
   * <path>`. Throws with a user-facing message to refuse. Absent = no switching.
   */
  switchTarget?: (path: string) => SwitchedTarget;
}

export interface SwitchedTarget {
  targetDir: string;
  config: SweepConfig;
  init?: SweepUiInitOptions;
  /** Config warnings: stderr would paint over the UI, so they arrive here. */
  warnings?: string[];
}

/** What the app needs to offer and perform a folder switch. */
export interface FolderSwitcher {
  list: () => JumpTarget[];
  /** Null when the switch happened; otherwise why it was refused. */
  go: (path: string) => string | null;
}

/** Recent cleanups, newest first, one per folder - suggestions only. */
function recentCleans(): RecentClean[] {
  try {
    const seen = new Set<string>();
    return [...readHistory(100)]
      .reverse()
      .filter((entry) => !seen.has(entry.targetDir) && seen.add(entry.targetDir))
      .slice(0, 8)
      .map(({ targetDir, ts, bytesFreed }) => ({ targetDir, ts, bytesFreed }));
  } catch {
    return [];
  }
}

const BATCH_FLUSH_MS = 60;
// A burst walk (rust on a warm tree can find hundreds of matches inside one
// window) must not wait out the timer - flush at the cap and keep the paint
// pipeline fed. Sits between opencode's 16ms transport window and ncdu's
// 100ms draw cap on purpose.

function emptyPlan(targetDir: string, selectionPolicy: SelectionPolicy): ScanPlan {
  return {
    protocolVersion: PROTOCOL_VERSION,
    targetDir,
    selectionPolicy,
    candidates: [],
    summary: {
      candidateCount: 0,
      estimatedTotalBytes: 0,
      scannedDirs: 0,
      exact: false,
      selectedCount: 0,
      riskCounts: { safe: 0, caution: 0, dangerous: 0, blocked: 0 },
    },
    selectedCandidateIds: [],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Interactive UI over a live scan.
 *
 * The TUI mounts immediately; candidates stream in as they are discovered and
 * sized. `r` rescans in place using the current pattern editor state.
 */
export async function runSweepUiStreaming(
  options: SweepUiStreamingOptions,
): Promise<SweepUiOutcome> {
  const preferencesRoot = resolve(sweepConfigDir());
  const preferences = loadViewPreferences(preferencesRoot);
  let latestPreferences: ViewPreferences | undefined;
  let initialPreferences: ViewPreferences | undefined;
  const onPreferencesChange = (value: ViewPreferences) => {
    initialPreferences ??= value;
    latestPreferences = value;
  };
  const session = await openUiSession();
  // The folder under review. ctrl-o swaps all three together; nothing else
  // in the session may hold on to an older target.
  let target: SwitchedTarget = {
    targetDir: options.targetDir,
    config: options.config,
    ...(options.init ? { init: options.init } : {}),
  };
  let currentConfig = options.config;
  let generation = 0;
  let switchNotice: string | undefined;
  // Mutable so `E` can flip backends between generations; `start` reads it
  // fresh each run so an in-flight scan is never disturbed mid-flight.
  let activeEngine = options.engine;

  const makeControl = (): UiScanControl => ({
    ...(options.dryRun
      ? {}
      : {
          applyPolicy: {
            maxSizeGB: currentConfig.maxSizeGB,
            forceLarge: options.forceLarge ?? false,
          },
        }),
    async start(hooks, signal) {
      // SWEEP_COLD: every scan - including `r` rescans - pays the cold costs
      // a fresh user pays (probe respawns at resolve; page cache drops when
      // permitted). Silent here: a stderr note would paint over the TUI.
      if (isColdRequested()) tryDropPageCache();
      let scannedDirs = 0;
      let skippedDirs = 0;
      let currentDir: string | undefined;
      const sizedIds = new Set<string>();
      let recordCount = 0;
      const batcher = new StreamBatcher<ScanCandidate, UiScanProgress>(
        (candidates, progress) => {
          if (signal.aborted) return;
          if (progress) hooks.onProgress?.(progress);
          if (candidates.length > 0) hooks.onBatch(candidates);
          return hooks.waitForCommit?.();
        },
        BATCH_FLUSH_MS,
        () => scanBatchCap(recordCount),
      );
      const cancel = () => batcher.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) batcher.cancel();
      const reportProgress = (dirs: number, skipped: number, dir?: string) => {
        scannedDirs = dirs;
        skippedDirs = skipped;
        currentDir = dir;
        batcher.progress({
          scannedDirs,
          skippedDirs,
          sizedCount: sizedIds.size,
          ...(currentDir === undefined ? {} : { currentDir }),
        });
      };
      const record = (entry: ScanEntry) => {
        if (signal.aborted) return;
        const candidate = candidateFromEntry(entry);
        recordCount++;
        batcher.record(candidate.id, candidate);
        return candidate;
      };
      const recordSized = (entry: ScanEntry) => {
        const candidate = record(entry);
        if (!candidate) return;
        sizedIds.add(candidate.id);
        reportProgress(scannedDirs, skippedDirs, currentDir);
      };

      try {
        // The authoritative enriched plan - cross-candidate insights need the
        // whole set, so per-entry `candidateFromEntry` stubs are reconciled
        // against this when the scan ends.
        let finalPlan: ScanPlan | undefined;
        if (activeEngine === "rust") {
          const { scanToPlanViaRust } = await import("@kitsunekode/sweep-core/rust-engine");
          const plan = await scanToPlanViaRust(target.targetDir, {
            config: currentConfig,
            resourceProfile: options.resourceProfile,
            waitForConsumer: () => batcher.waitForConsumer(),
            selectionPolicy: options.selectionPolicy,
            exact: false,
            onEntry: record,
            onEntrySized: recordSized,
            onProgress: ({ scannedDirs: dirs, skippedDirs: skipped, currentDir }) =>
              reportProgress(dirs, skipped, currentDir),
            signal,
          });
          scannedDirs = plan.summary.scannedDirs;
          skippedDirs = plan.summary.skippedDirs ?? 0;
          finalPlan = plan;
        } else {
          const result = await scan(target.targetDir, currentConfig, false, {
            resourceProfile: options.resourceProfile,
            waitForConsumer: () => batcher.waitForConsumer(),
            onEntry: record,
            onEntrySized: recordSized,
            onProgress: ({ scannedDirs: dirs, skippedDirs: skipped, currentDir }) =>
              reportProgress(dirs, skipped, currentDir),
            signal,
          });
          scannedDirs = result.scannedDirs;
          skippedDirs = result.skippedDirs;
          finalPlan = buildPlan(target.targetDir, result, options.selectionPolicy);
        }

        await batcher.finish();
        if (!signal.aborted) hooks.onDone({ scannedDirs, skippedDirs, plan: finalPlan });
      } catch (error) {
        batcher.cancel();
        if (!signal.aborted) hooks.onError(error);
      } finally {
        batcher.cancel();
        signal.removeEventListener("abort", cancel);
      }
    },
    syncPatterns(disabledPatterns, extraPatterns) {
      currentConfig = buildRescanConfig(target.config, {
        disabledPatterns,
        extraPatterns,
      });
    },
    setEngine(engine) {
      // Flip must not rescan with a dead backend and surface as a scan error.
      if (engine === "rust" && !isRustEngineAvailable()) return false;
      activeEngine = engine;
      return true;
    },
    ...(options.apply
      ? {
          apply: (request: Parameters<NonNullable<UiScanControl["apply"]>>[0]) =>
            options.apply!({ ...request, engine: activeEngine }),
        }
      : {}),
  });

  // A switched-to folder keeps the theme and sort the user just chose.
  const currentPreferences = () => latestPreferences ?? preferences;
  let render: () => void = () => {};
  const folders: FolderSwitcher | undefined = options.switchTarget
    ? {
        list: () => discoverJumpTargets(target.targetDir, recentCleans()),
        go: (path) => {
          if (session.operations.busy || session.operations.closing)
            return "Wait for the running cleanup to finish, then switch.";
          let next: SwitchedTarget;
          try {
            next = options.switchTarget!(path);
          } catch (error) {
            // One readable sentence: guardrail messages carry their own line breaks.
            const message = error instanceof Error ? error.message : String(error);
            return sanitizeTerminalText(
              message
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .join(" "),
            ).slice(0, 240);
          }
          target = next;
          currentConfig = next.config;
          generation++;
          switchNotice = next.warnings?.[0]
            ? `config: ${sanitizeTerminalText(next.warnings[0]).slice(0, 160)}`
            : `now reviewing ${sanitizeTerminalText(tildePath(next.targetDir))}`;
          // A fresh app instance: the old one's unmount aborts its scan, and
          // no queue, filter or scope from the previous folder survives.
          render();
          return null;
        },
      }
    : undefined;

  render = () => {
    try {
      session.root.render(
        <UiErrorBoundary onError={session.viewFailed}>
          <SweepApp
            key={generation}
            plan={emptyPlan(target.targetDir, options.selectionPolicy)}
            engine={options.engine}
            {...(options.dryRun ? { dryRun: true } : {})}
            {...(options.trash ? { trash: true } : {})}
            {...(target.init ? { init: target.init } : {})}
            initiallyScanning
            scan={makeControl()}
            {...(folders ? { folders } : {})}
            {...(switchNotice ? { initialNotice: switchNotice } : {})}
            operations={session.operations}
            {...(currentPreferences() ? { preferences: currentPreferences()! } : {})}
            onPreferencesChange={onPreferencesChange}
            onDone={session.finish}
          />
        </UiErrorBoundary>,
      );
    } catch (error) {
      session.viewFailed(error);
    }
  };
  render();
  const outcome = await session.done;
  if (
    latestPreferences &&
    JSON.stringify(latestPreferences) !== JSON.stringify(initialPreferences)
  ) {
    try {
      saveViewPreferences(latestPreferences, preferencesRoot);
    } catch {
      process.stderr.write(
        "Appearance preferences were not saved; this session's cleanup result is unchanged.\n",
      );
    }
  }
  return outcome;
}
