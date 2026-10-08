#!/usr/bin/env bun
/** Synthetic live producer + real native in-memory UI; no filesystem deletion. */
import { createTestRenderer } from "@opentui/core/testing";
import { heapStats } from "bun:jsc";
import { createRoot, flushSync } from "@opentui/react";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { SweepApp } from "../src/app.js";
import type { UiScanHooks } from "../src/streaming.js";
import { StreamBatcher, scanBatchCap } from "../src/stream-batcher.js";
import { releaseUiCaches } from "../src/state/store.js";

const raw = process.argv[process.argv.indexOf("--candidates") + 1];
const count = process.argv.includes("--candidates") ? Number(raw) : 10000;
if (!Number.isSafeInteger(count) || count < 1 || count > 100000)
  throw new Error("Invalid candidate count (1..100000)");
const awaitCommit = !process.argv.includes("--event-loop-only");
const diagnoseMemory = process.argv.includes("--memory-diagnostics");
const widthArg = process.argv.indexOf("--width");
const width = widthArg < 0 ? 120 : Number(process.argv[widthArg + 1]);
if (!Number.isSafeInteger(width) || width < 40 || width > 240)
  throw new Error("Invalid terminal width (40..240)");
const candidates: ScanCandidate[] = Array.from({ length: count }, (_, i) => ({
  id: `candidate_${i}`,
  path: `/tmp/sweep-stream-synthetic/project-${i}/node_modules`,
  name: "node_modules",
  kind: "node_modules",
  entryType: "directory",
  isSymlink: false,
  estimatedBytes: i,
  bytesKnown: true,
  riskTier: "safe",
  selectedByDefault: false,
  reasons: ["default-pattern"],
}));
const plan: ScanPlan = {
  protocolVersion: "1",
  targetDir: "/tmp/sweep-stream-synthetic",
  selectionPolicy: { mode: "none", includeDangerous: false },
  candidates,
  selectedCandidateIds: [],
  createdAt: new Date().toISOString(),
  summary: {
    candidateCount: count,
    selectedCount: 0,
    estimatedTotalBytes: (count * (count - 1)) / 2,
    scannedDirs: count + 1,
    exact: false,
    riskCounts: { safe: count, caution: 0, dangerous: 0, blocked: 0 },
  },
};
let hooks!: UiScanHooks;
let signal!: AbortSignal;
let batches = 0;
let records = 0;
let outstanding = 0;
let maxOutstanding = 0;
let sampledPeakRss = process.memoryUsage().rss;
const inputPaintMs: number[] = [];
let updateDepthWarnings = 0;
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  if (
    args.some((arg) => typeof arg === "string" && arg.includes("Maximum update depth exceeded"))
  ) {
    updateDepthWarnings++;
  }
  originalConsoleError(...args);
};
const setup = await createTestRenderer({
  width,
  height: 32,
  exitOnCtrlC: false,
  exitSignals: [],
});
const root = createRoot(setup.renderer);
root.render(
  <SweepApp
    plan={{ ...plan, candidates: [], selectedCandidateIds: [] }}
    initiallyScanning
    onDone={() => {}}
    scan={{
      async start(h, s) {
        hooks = h;
        signal = s;
      },
      syncPatterns() {},
      setEngine: () => true,
    }}
  />,
);
let elapsedMs = 0;
let finished = false;
let failure: unknown;
let producer: Promise<void> | undefined;
let stopProducer = false;
let started = 0;
let memoryBeforeCleanup: ReturnType<typeof heapStats> | undefined;
let memoryAfterCleanup: ReturnType<typeof heapStats> | undefined;
const batcher = new StreamBatcher<ScanCandidate, number>(
  (items) => {
    batches++;
    hooks.onBatch(items);
    hooks.onProgress?.({ scannedDirs: batches, skippedDirs: 0 });
    outstanding++;
    maxOutstanding = Math.max(maxOutstanding, outstanding);
    const receipt = hooks.waitForCommit!().then(() => {
      outstanding--;
    });
    return awaitCommit ? receipt : undefined;
  },
  60,
  () => scanBatchCap(records),
);
try {
  for (let pass = 0; hooks === undefined && pass < 100; pass++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await setup.renderOnce();
  }
  if (hooks === undefined) throw new Error("UI did not register scan hooks");
  await setup.renderOnce();
  // This is a production-scheduling benchmark, not an act() correctness test.
  // act() drains the entire async producer and masks input scheduling.
  started = performance.now();
  producer = (async () => {
    for (const candidate of candidates) {
      if (signal.aborted || stopProducer) return;
      records++;
      batcher.record(candidate.id, candidate);
      await batcher.waitForConsumer();
    }
    // Replay sizing updates, exercising replacement as well as discovery.
    for (const candidate of candidates) {
      if (signal.aborted || stopProducer) return;
      records++;
      batcher.record(candidate.id, candidate);
      await batcher.waitForConsumer();
    }
    await batcher.finish();
    if (signal.aborted || stopProducer) return;
    hooks.onDone({ scannedDirs: count + 1, skippedDirs: 0, plan });
    await hooks.waitForCommit!();
  })()
    .catch((error: unknown) => {
      failure = error;
    })
    .finally(() => {
      finished = true;
    });
  let lastInputBatch = 0;
  while (!finished) {
    const measureInput = batches > lastInputBatch;
    const before = performance.now();
    if (measureInput) {
      setup.mockInput.pressArrow("down");
      lastInputBatch = batches;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
    await setup.renderOnce();
    if (measureInput) {
      setup.captureCharFrame();
      inputPaintMs.push(performance.now() - before);
    }
    sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss);
    if (sampledPeakRss > 1024 ** 3)
      throw new Error("Streaming probe exceeded its 1 GiB sampled RSS budget");
    if (performance.now() - started > 120000)
      throw new Error("Streaming probe exceeded two minutes");
  }
  await producer;
  if (failure) throw failure;
  await setup.renderOnce();
  await setup.flush();
  elapsedMs = performance.now() - started;
  const frame = setup.captureCharFrame();
  // Narrow headers omit discovery counts and input can dismiss the completion
  // notice. Their final assertion covers completion state; full counts are
  // asserted in the default-width probe and reducer correctness tests.
  if (
    !(width < 100 ? frame.includes("NORMAL") : frame.includes(`${count} found`)) ||
    frame.includes("SCANNING") ||
    frame.includes("INCOMPLETE")
  )
    throw new Error(`Final frame did not reconcile: ${frame}`);
  if (updateDepthWarnings > 0) throw new Error("UI emitted maximum update depth warnings");
} catch (error) {
  failure = error;
} finally {
  elapsedMs = started ? performance.now() - started : 0;
  stopProducer = true;
  if (diagnoseMemory) memoryBeforeCleanup = heapStats();
  batcher.cancel();
  flushSync(() => root.unmount());
  setup.renderer.destroy();
  await producer;
  releaseUiCaches();
  console.error = originalConsoleError;
  if (diagnoseMemory) {
    Bun.gc(true);
    memoryAfterCleanup = heapStats();
  }
}
inputPaintMs.sort((a, b) => a - b);
const percentile = (p: number) =>
  inputPaintMs[Math.max(0, Math.ceil(inputPaintMs.length * p) - 1)] ?? null;
console.log(
  JSON.stringify(
    {
      runtime: Bun.version,
      width,
      status: failure === undefined ? "passed" : "failed",
      ...(failure === undefined
        ? {}
        : { error: failure instanceof Error ? failure.message : String(failure) }),
      candidates: count,
      scopes: count,
      batches,
      awaitCommit,
      maxOutstanding,
      elapsedMs,
      inputSamples: inputPaintMs.length,
      tailSampleMinimumMet: inputPaintMs.length >= 100,
      inputPaintP50Ms: percentile(0.5),
      inputPaintP95Ms: percentile(0.95),
      inputPaintP99Ms: percentile(0.99),
      sampledPeakRssMiB: sampledPeakRss / 1024 ** 2,
      forcedGc: diagnoseMemory,
      updateDepthWarnings,
      ...(diagnoseMemory
        ? {
            memoryBeforeCleanup,
            memoryAfterCleanup,
            rssAfterCleanupMiB: process.memoryUsage().rss / 1024 ** 2,
          }
        : {}),
      realFilesystemScan: false,
      physicalTerminalIncluded: false,
      method:
        "Synthetic discovery and sizing, actual UI hooks/commit receipts, OpenTUI native in-memory output. Event-loop-only is a comparison mode, not a shipped setting.",
    },
    null,
    2,
  ),
);
if (failure !== undefined) process.exitCode = 1;
