#!/usr/bin/env bun
/** In-memory native terminal frames; never scans or removes filesystem data. */
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SweepApp } from "../src/app.js";
import { releaseUiCaches } from "../src/state/store.js";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";

function countFlag(name: string, fallback: number, maximum: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1] ?? "";
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${name}`);
  const n = Number(raw);
  if (n < 1 || n > maximum) throw new Error(`Invalid ${name}`);
  return n;
}
const count = countFlag("--candidates", 5000, 100000);
const scopes = countFlag("--scopes", Math.min(100, count), count);
const cycles = countFlag("--cycles", 5, 100);
const samples = countFlag("--samples", 100, 1000);
const rows: Array<{
  cycle: number;
  firstFrameMs: number;
  inputPaintMs: number[];
  rss: number;
  heapUsed: number;
}> = [];
for (let cycle = 0; cycle < cycles; cycle++) {
  const candidates: ScanCandidate[] = Array.from({ length: count }, (_, i) => ({
    id: `candidate_${i}`,
    path: `/tmp/sweep-ui-synthetic/project-${i % scopes}/node_modules-${i}`,
    name: `node_modules-${i}`,
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
    targetDir: "/tmp/sweep-ui-synthetic",
    selectionPolicy: { mode: "none", includeDangerous: false },
    candidates,
    selectedCandidateIds: [],
    createdAt: new Date().toISOString(),
    summary: {
      candidateCount: count,
      selectedCount: 0,
      estimatedTotalBytes: (count * (count - 1)) / 2,
      scannedDirs: scopes + 1,
      exact: false,
      riskCounts: { safe: count, caution: 0, dangerous: 0, blocked: 0 },
    },
  };
  const start = performance.now();
  const setup = await testRender(<SweepApp plan={plan} onDone={() => {}} />, {
    width: 120,
    height: 32,
    exitOnCtrlC: false,
  });
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    await setup.renderOnce();
    const firstFrameMs = performance.now() - start;
    if (!setup.captureCharFrame().includes("artifacts"))
      throw new Error("Missing usable artifact frame");
    const inputPaintMs: number[] = [];
    for (let i = 0; i < samples; i++) {
      const before = performance.now();
      await act(async () => {
        setup.mockInput.pressArrow("down");
      });
      await setup.renderOnce();
      setup.captureCharFrame();
      inputPaintMs.push(performance.now() - before);
    }
    await act(async () => {
      setup.mockInput.pressKey("u");
    });
    await setup.renderOnce();
    rows.push({
      cycle,
      firstFrameMs,
      inputPaintMs,
      rss: process.memoryUsage().rss,
      heapUsed: process.memoryUsage().heapUsed,
    });
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
    releaseUiCaches();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
}
const sorted = rows.flatMap((row) => row.inputPaintMs).sort((a, b) => a - b);
const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
console.log(
  JSON.stringify(
    {
      candidates: count,
      scopes,
      cycles,
      samplesPerCycle: samples,
      forcedGc: false,
      paintingIncluded: true,
      renderer: "OpenTUI native in-memory output",
      physicalTerminalIncluded: false,
      inputPaintP50Ms: percentile(0.5),
      inputPaintP95Ms: percentile(0.95),
      inputPaintP99Ms: percentile(0.99),
      sampledPeakRssMiB: Math.max(...rows.map((row) => row.rss)) / 1024 ** 2,
      rows,
    },
    null,
    2,
  ),
);
