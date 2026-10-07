import { isColdRequested, tryDropPageCache } from "@kitsunekode/sweep-core/cold";
import { buildRescanConfig } from "@kitsunekode/sweep-core/config";
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
import { PROTOCOL_VERSION } from "@kitsunekode/sweep-protocol";
import { SweepApp, UiErrorBoundary } from "./app.js";
import type { SweepUiOutcome, UiApplyResult } from "./outcome.js";
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
  apply?: (request: {
    plan: ScanPlan;
    trash: boolean;
    signal: AbortSignal;
    onProgress?: (progress: import("@kitsunekode/sweep-protocol").ApplyProgress) => void;
  }) => Promise<UiApplyResult>;
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
  apply?: (request: {
    plan: ScanPlan;
    engine: "js" | "rust";
    trash: boolean;
    signal: AbortSignal;
    onProgress?: (progress: import("@kitsunekode/sweep-protocol").ApplyProgress) => void;
  }) => Promise<UiApplyResult>;
  init?: SweepUiInitOptions;
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
  const session = await openUiSession();
  let currentConfig = options.config;
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
      };
      const recordSized = (entry: ScanEntry) => {
        if (signal.aborted) return;
        sizedIds.add(candidateFromEntry(entry).id);
        reportProgress(scannedDirs, skippedDirs, currentDir);
        record(entry);
      };

      try {
        // The authoritative enriched plan - cross-candidate insights need the
        // whole set, so per-entry `candidateFromEntry` stubs are reconciled
        // against this when the scan ends.
        let finalPlan: ScanPlan | undefined;
        if (activeEngine === "rust") {
          const { scanToPlanViaRust } = await import("@kitsunekode/sweep-core/rust-engine");
          const plan = await scanToPlanViaRust(options.targetDir, {
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
          const result = await scan(options.targetDir, currentConfig, false, {
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
          finalPlan = buildPlan(options.targetDir, result, options.selectionPolicy);
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
      currentConfig = buildRescanConfig(options.config, {
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

  try {
    session.root.render(
      <UiErrorBoundary>
        <SweepApp
          plan={emptyPlan(options.targetDir, options.selectionPolicy)}
          engine={options.engine}
          {...(options.dryRun ? { dryRun: true } : {})}
          {...(options.trash ? { trash: true } : {})}
          {...(options.init ? { init: options.init } : {})}
          initiallyScanning
          scan={makeControl()}
          onDone={session.finish}
        />
      </UiErrorBoundary>,
    );
  } catch (error) {
    session.finish({ type: "abort" });
    throw error instanceof Error ? error : new Error(String(error));
  }
  return await session.done;
}
