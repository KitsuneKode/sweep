import { buildRescanConfig } from "@kitsunekode/sweep-core/config";
import { candidateFromEntry } from "@kitsunekode/sweep-core/planner";
import { scan } from "@kitsunekode/sweep-core/scanner";
import type {
  ScanCandidate,
  ScanEntry,
  ScanPlan,
  SelectionPolicy,
  SweepConfig,
} from "@kitsunekode/sweep-protocol";
import { PROTOCOL_VERSION } from "@kitsunekode/sweep-protocol";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { SweepApp, UiErrorBoundary } from "./app.js";
import type { SweepUiOutcome } from "./outcome.js";
import type { SweepUiInitOptions } from "./state.js";

/** Callbacks the app registers for one scan generation. */
export interface UiScanHooks {
  /** Candidates discovered or resized since the last flush. */
  onBatch: (candidates: ScanCandidate[]) => void;
  onDone: (meta: { scannedDirs: number }) => void;
  onError: (error: unknown) => void;
}

/** Live-scan control handed to the app; every call starts a new generation. */
export interface UiScanControl {
  start(hooks: UiScanHooks, signal: AbortSignal): void;
  /** Push pattern-editor changes so the next rescan uses them. */
  syncPatterns(disabledPatterns: string[], extraPatterns: string[]): void;
}

export interface SweepUiStreamingOptions {
  targetDir: string;
  /** Resolved scan config (patterns/ignore/depth/maxSizeGB). */
  config: SweepConfig;
  selectionPolicy: SelectionPolicy;
  engine: "js" | "rust";
  dryRun?: boolean;
  init?: SweepUiInitOptions;
}

const BATCH_FLUSH_MS = 60;

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
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    useMouse: true,
    targetFps: 30,
  });

  return await new Promise<SweepUiOutcome>((resolvePromise, rejectPromise) => {
    const root = createRoot(renderer);
    const cleanup = () => {
      root.unmount();
      renderer.destroy();
    };

    let currentConfig = options.config;

    const makeControl = (): UiScanControl => ({
      async start(hooks, signal) {
        // Buffer discoveries so React sees batches, not per-entry renders.
        const buffer = new Map<string, ScanCandidate>();
        let timer: ReturnType<typeof setTimeout> | null = null;

        const flush = () => {
          timer = null;
          if (signal.aborted || buffer.size === 0) return;
          const batch = [...buffer.values()];
          buffer.clear();
          hooks.onBatch(batch);
        };
        const schedule = () => {
          if (timer === null && !signal.aborted) timer = setTimeout(flush, BATCH_FLUSH_MS);
        };
        const record = (entry: ScanEntry) => {
          if (signal.aborted) return;
          const candidate = candidateFromEntry(entry);
          buffer.set(candidate.id, candidate); // sized upserts replace stubs
          schedule();
        };

        try {
          let scannedDirs = 0;
          if (options.engine === "rust") {
            const { scanToPlanViaRust } = await import("@kitsunekode/sweep-core/rust-engine");
            const plan = await scanToPlanViaRust(options.targetDir, {
              config: currentConfig,
              selectionPolicy: options.selectionPolicy,
              exact: false,
              onEntry: record,
              onEntrySized: record,
            });
            scannedDirs = plan.summary.scannedDirs;
          } else {
            const result = await scan(options.targetDir, currentConfig, false, {
              onEntry: record,
              onEntrySized: record,
              signal,
            });
            scannedDirs = result.scannedDirs;
          }

          flush();
          if (!signal.aborted) hooks.onDone({ scannedDirs });
        } catch (error) {
          flush();
          if (!signal.aborted) hooks.onError(error);
        }
      },
      syncPatterns(disabledPatterns, extraPatterns) {
        currentConfig = buildRescanConfig(options.config, {
          disabledPatterns,
          extraPatterns,
        });
      },
    });

    try {
      root.render(
        <UiErrorBoundary>
          <SweepApp
            plan={emptyPlan(options.targetDir, options.selectionPolicy)}
            {...(options.dryRun ? { dryRun: true } : {})}
            {...(options.init ? { init: options.init } : {})}
            initiallyScanning
            scan={makeControl()}
            onDone={(outcome) => {
              cleanup();
              resolvePromise(outcome);
            }}
          />
        </UiErrorBoundary>,
      );
    } catch (error) {
      cleanup();
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
