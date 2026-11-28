import { isColdRequested } from "@kitsunekode/sweep-core/cold";
import { type Dispatch, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { engineTimingLabel, type UiAction } from "./app-helpers.js";
import {
  finalizeScan,
  rescanConfigFromState,
  resetForRescan,
  setScanCurrentDir,
  setScannedDirs,
  setScanning,
  setSkippedDirs,
  upsertCandidates,
  type SweepUiState,
} from "./state.js";
import type { UiScanControl } from "./streaming.js";
import type { NoticeTone } from "./theme.js";

export interface UseLiveScanOptions {
  scan: UiScanControl | undefined;
  initiallyScanning: boolean | undefined;
  engine: "js" | "rust" | undefined;
  scanningNow: boolean;
  dispatch: Dispatch<UiAction>;
  readFreshState: () => SweepUiState;
  setScanError: (message: string | null) => void;
  setNotice: (text: string | null, tone?: NoticeTone) => void;
}

export function useLiveScan({
  scan,
  initiallyScanning,
  engine,
  scanningNow,
  dispatch,
  readFreshState,
  setScanError,
  setNotice,
}: UseLiveScanOptions) {
  const callbacksRef = useRef({ readFreshState, setScanError, setNotice });
  callbacksRef.current = { readFreshState, setScanError, setNotice };

  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [scanCommitToken, setScanCommitToken] = useState(0);
  const scanCommitSequence = useRef(0);
  const scanCommitWaiters = useRef(new Map<number, () => void>());
  useLayoutEffect(() => {
    for (const [token, release] of scanCommitWaiters.current) {
      if (token <= scanCommitToken) release();
    }
  }, [scanCommitToken]);

  // Engine the next scan generation runs (E flips it); the `engine` prop only
  // seeds the first generation. Timing per engine lives in scanDurationsRef
  // so the notice can compare backends on the same tree.
  const [activeEngine, setActiveEngine] = useState<"js" | "rust">(engine ?? "js");
  // Mirror in a ref - startScan is a useCallback and reads the engine at
  // start() time, so the E-toggle's setState must not race the closure.
  const activeEngineRef = useRef(activeEngine);
  const scanStartRef = useRef(0);
  // Ref carries the authoritative map (readable mid-callback); state mirrors
  // it so the header chip re-renders when a run's duration lands.
  const scanDurationsRef = useRef<Partial<Record<"js" | "rust", number>>>({});
  const [scanDurations, setScanDurations] = useState(scanDurationsRef.current);
  // Coarse ticker - the scanning strip's elapsed readout ticks at 4Hz while a
  // scan runs, independent of progress-event cadence (a slow dir would
  // otherwise freeze the readout).
  const [, setScanTick] = useState(0);

  // Live-scan lifecycle: boot into the first generation, restart on rescan.
  const startScan = useCallback(() => {
    if (!scan) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const gen = ++generationRef.current;
    const engineForRun = activeEngineRef.current;
    const startedAt = performance.now();
    scanStartRef.current = startedAt;
    callbacksRef.current.setScanError(null);
    dispatch({ type: "mutate", fn: (s) => setScanning(s, true) });
    // Deliberately floating: a rejecting UiScanControl still becomes an
    // unhandled rejection - funnel it through the same path as onError.
    void Promise.resolve()
      .then(() => {
        if (gen !== generationRef.current || controller.signal.aborted) return;
        return scan.start(
          {
            waitForCommit: () => {
              if (gen !== generationRef.current || controller.signal.aborted)
                return Promise.resolve();
              const token = ++scanCommitSequence.current;
              const receipt = new Promise<void>((resolve) => {
                const release = () => {
                  scanCommitWaiters.current.delete(token);
                  controller.signal.removeEventListener("abort", release);
                  resolve();
                };
                scanCommitWaiters.current.set(token, release);
                controller.signal.addEventListener("abort", release, { once: true });
              });
              setScanCommitToken(token);
              return receipt;
            },
            onBatch: (candidates) => {
              if (gen !== generationRef.current || controller.signal.aborted) return;
              dispatch({ type: "mutate", fn: (s) => upsertCandidates(s, candidates) });
            },
            onProgress: ({ scannedDirs, skippedDirs, currentDir, sizedCount }) => {
              if (gen !== generationRef.current || controller.signal.aborted) return;
              dispatch({
                type: "mutate",
                fn: (s) => ({
                  ...setScanCurrentDir(
                    setSkippedDirs(setScannedDirs(s, scannedDirs), skippedDirs),
                    currentDir ?? null,
                  ),
                  scanSizedCount: sizedCount ?? s.scanSizedCount,
                }),
              });
            },
            onDone: ({ scannedDirs, skippedDirs, plan: finalPlan }) => {
              if (gen !== generationRef.current || controller.signal.aborted) return;
              // Monotonic elapsed for this generation - excludes UI idle time and
              // any earlier aborted run, so js-vs-rust comparisons stay honest.
              const elapsedMs = Math.max(0, performance.now() - startedAt);
              scanDurationsRef.current = { ...scanDurationsRef.current, [engineForRun]: elapsedMs };
              setScanDurations(scanDurationsRef.current);
              // The scan chip quietly flipping to NORMAL is the only signal today
              // - say what landed so the end of a long scan is legible at a
              // glance, with the engine comparison the E-toggle is for.
              const found = finalPlan?.candidates.length;
              const base =
                found !== undefined
                  ? `scan complete: ${found.toLocaleString()} artifact${found === 1 ? "" : "s"} · ${scannedDirs.toLocaleString()} dirs`
                  : `scan complete: ${scannedDirs.toLocaleString()} dirs`;
              callbacksRef.current.setNotice(
                `${base}${skippedDirs > 0 ? ` · ${skippedDirs} skipped (partial scan)` : ""} · ${engineTimingLabel(engineForRun, scanDurationsRef.current)}${isColdRequested() ? " · cold" : ""}`,
                skippedDirs > 0 ? "warning" : "success",
              );
              dispatch({
                type: "mutate",
                fn: (s) =>
                  finalizeScan(
                    setSkippedDirs(setScannedDirs(s, scannedDirs), skippedDirs),
                    finalPlan,
                  ),
              });
            },
            onError: (error) => {
              if (gen !== generationRef.current || controller.signal.aborted) return;
              dispatch({ type: "mutate", fn: (s) => setScanning(s, false) });
              callbacksRef.current.setScanError(
                error instanceof Error ? error.message : String(error),
              );
            },
          },
          controller.signal,
        );
      })
      .catch((error: unknown) => {
        if (gen !== generationRef.current || controller.signal.aborted) return;
        dispatch({ type: "mutate", fn: (s) => setScanning(s, false) });
        callbacksRef.current.setScanError(error instanceof Error ? error.message : String(error));
      });
  }, [scan, activeEngine, dispatch]);

  useEffect(() => {
    if (scan && initiallyScanning) startScan();
    return () => {
      abortRef.current?.abort();
    };
    // Boot-only effect; rescans are triggered explicitly via r.
  }, []);

  // 4Hz elapsed ticker, live only while a scan runs - progress events already
  // re-render the strip, this keeps the readout honest through a slow dir.
  useEffect(() => {
    if (!scanningNow) return;
    const id = setInterval(() => setScanTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [scanningNow]);

  const requestRescan = useCallback(() => {
    if (!scan) return;
    // Flush queued mutations (pattern toggles in the same input burst) so the
    // rescan actually scans what the user just toggled - otherwise r applies
    // the pre-burst pattern set while the UI already shows the new one.
    const { disabledPatterns, extraPatterns } = rescanConfigFromState(
      callbacksRef.current.readFreshState(),
    );
    scan.syncPatterns(disabledPatterns, extraPatterns);
    dispatch({ type: "mutate", fn: resetForRescan });
    startScan();
  }, [scan, startScan, dispatch]);

  // E: swap scan engines and rescan the same tree - the completion notice
  // reports the new engine's time against any prior run so the faster backend
  // is legible at a glance, no benchmark harness required.
  const toggleEngine = useCallback(() => {
    if (!scan) {
      callbacksRef.current.setNotice("engine switch needs a live scan - run `sweep ui`");
      return;
    }
    const next = activeEngine === "rust" ? "js" : "rust";
    if (!scan.setEngine(next)) {
      callbacksRef.current.setNotice(
        `${next} engine unavailable - no sweep-engine binary resolved`,
      );
      return;
    }
    // Ref first - startScan reads it synchronously; the setState is render
    // scheduling only.
    activeEngineRef.current = next;
    setActiveEngine(next);
    const { disabledPatterns, extraPatterns } = rescanConfigFromState(
      callbacksRef.current.readFreshState(),
    );
    scan.syncPatterns(disabledPatterns, extraPatterns);
    dispatch({ type: "mutate", fn: resetForRescan });
    startScan();
  }, [scan, activeEngine, startScan, dispatch]);

  const abortScan = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    activeEngine,
    scanStartRef,
    scanDurations,
    requestRescan,
    toggleEngine,
    abortScan,
  };
}
