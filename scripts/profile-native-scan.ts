#!/usr/bin/env bun
/** Read-only native scan timing: compare one-shot and streamed host delivery. */
import { resolve } from "node:path";
import { loadConfig } from "@kitsunekode/sweep-core/config";
import { scanToPlanViaRust } from "@kitsunekode/sweep-core/rust-engine";

const args = process.argv.slice(2);
const target = args[0];
const runs = args.length === 1 ? 3 : Number(args[2]);
if (
  !target ||
  target.startsWith("--") ||
  !(args.length === 1 || (args.length === 3 && args[1] === "--runs")) ||
  !Number.isInteger(runs) ||
  runs < 1 ||
  runs > 10
) {
  throw new Error("Usage: bun scripts/profile-native-scan.ts <target> [--runs 1..10]");
}
const root = resolve(target);
const config = loadConfig(root);
const samples = [];
for (let run = 0; run < runs; run++) {
  // Alternate order; do not label an uncontrolled page cache as cold.
  const modes = run % 2 ? (["streamed", "one-shot"] as const) : (["one-shot", "streamed"] as const);
  for (const mode of modes) {
    const started = performance.now();
    let firstCandidateMs: number | null = null;
    let lastCandidateMs: number | null = null;
    let foundEvents = 0;
    let sizedEvents = 0;
    const candidate = () => {
      lastCandidateMs = performance.now() - started;
      firstCandidateMs ??= lastCandidateMs;
    };
    const plan = await scanToPlanViaRust(root, {
      config,
      selectionPolicy: { mode: "none", includeDangerous: false },
      ...(mode === "streamed"
        ? {
            onEntry: () => {
              foundEvents++;
              candidate();
            },
            onEntrySized: () => {
              sizedEvents++;
              candidate();
            },
          }
        : {}),
    });
    const totalMs = performance.now() - started;
    samples.push({
      run: run + 1,
      mode,
      totalMs,
      firstCandidateMs,
      lastCandidateMs,
      afterLastCandidateMs: lastCandidateMs === null ? null : totalMs - lastCandidateMs,
      foundEvents,
      sizedEvents,
      candidates: plan.candidates.length,
      scannedDirs: plan.summary.scannedDirs,
      skippedDirs: plan.summary.skippedDirs ?? 0,
      estimatedBytes: plan.summary.estimatedTotalBytes,
    });
  }
}
console.log(
  JSON.stringify(
    {
      scope:
        "Read-only native subprocess scan and host validation/enrichment. No UI rendering, apply, cache drop or synthetic fixture generation.",
      cache:
        "Uncontrolled existing cache; no warmup omitted from the report. Active writers may change results between samples.",
      timing:
        "Times include host processing and child startup. afterLastCandidateMs also includes any remaining engine work; it is not isolated host CPU time.",
      samples,
    },
    null,
    2,
  ),
);
