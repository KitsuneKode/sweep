/** Local destructive benchmark. Every operation uses an owned mkdtemp fixture. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { applyPlanWithBackend } from "../src/engine.js";
import { buildPlan } from "../src/planner.js";
import { resolveRustEngineBinary } from "../src/rust-engine.js";
import type { ScanEntry } from "@kitsunekode/sweep-protocol";

const { values } = parseArgs({
  options: {
    samples: { type: "string", default: "7" },
    output: { type: "string" },
    "fixture-parent": { type: "string" },
  },
  args: process.argv.slice(2),
  strict: true,
});
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1 || samples > 100)
  throw new Error("samples must be 1–100");
const nativeBinary = resolveRustEngineBinary();
const fixtureParent = resolve(values["fixture-parent"] ?? tmpdir());
const nativeSha256 = createHash("sha256").update(readFileSync(nativeBinary)).digest("hex");
const rows: Array<Record<string, unknown>> = [];
for (const scenario of [
  { name: "many", candidates: 64, files: 16 },
  { name: "large", candidates: 1, files: 20000 },
]) {
  for (let iteration = 0; iteration < samples; iteration++) {
    for (const engine of iteration % 2 ? (["rust", "js"] as const) : (["js", "rust"] as const)) {
      const root = mkdtempSync(join(fixtureParent, "sweep-apply-benchmark-"));
      try {
        const entries: ScanEntry[] = [];
        for (let i = 0; i < scenario.candidates; i++) {
          const path = join(root, `project-${i}`, "node_modules");
          mkdirSync(path, { recursive: true });
          for (let j = 0; j < scenario.files; j++) {
            const parent =
              scenario.name === "large" ? join(path, `part-${Math.floor(j / 64)}`) : path;
            mkdirSync(parent, { recursive: true });
            writeFileSync(join(parent, `file-${j}`), "benchmark");
          }
          entries.push({
            path,
            name: "node_modules",
            entryType: "directory",
            isSymlink: false,
            estimatedBytes: scenario.files * 9,
            bytesKnown: true,
          });
        }
        const plan = buildPlan(root, {
          entries,
          estimatedTotalBytes: entries.reduce((n, e) => n + e.estimatedBytes, 0),
          scannedDirs: scenario.candidates + 1,
          skippedDirs: 0,
          exact: false,
        });
        let firstBegin: number | undefined;
        let firstDeleted: number | undefined;
        let callbacks = 0;
        let maxLag = 0;
        const started = performance.now();
        let previous = started;
        const heartbeat = setInterval(() => {
          const now = performance.now();
          maxLag = Math.max(maxLag, now - previous - 5);
          previous = now;
        }, 5);
        let result;
        try {
          result = await applyPlanWithBackend(plan, engine, {
            maxSizeGB: 10,
            onBegin: () => {
              firstBegin ??= performance.now() - started;
            },
            onDeleted: () => {
              callbacks++;
              firstDeleted ??= performance.now() - started;
            },
          });
        } finally {
          clearInterval(heartbeat);
        }
        const totalMs = performance.now() - started;
        if (
          result.report.deletedCount !== scenario.candidates ||
          result.report.failedCount ||
          result.interrupted ||
          callbacks !== scenario.candidates ||
          entries.some((entry) => existsSync(entry.path))
        )
          throw new Error("Apply outcome parity failed");
        rows.push({
          scenario: scenario.name,
          engine,
          iteration,
          totalMs,
          firstBeginMs: firstBegin,
          firstDeletedMs: firstDeleted,
          maxLagMs: maxLag,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
}
const quantile = (values: number[], p: number) =>
  values.slice().sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;
const summary = ["many", "large"].flatMap((scenario) =>
  ["js", "rust"].map((engine) => {
    const group = rows.filter((row) => row.scenario === scenario && row.engine === engine);
    const timings = group.map((row) => row.totalMs as number);
    return {
      scenario,
      engine,
      samples,
      medianMs: quantile(timings, 0.5),
      maxMs: Math.max(...timings),
      p99Ms: samples >= 100 ? quantile(timings, 0.99) : null,
    };
  }),
);
const output =
  JSON.stringify(
    {
      date: new Date().toISOString(),
      runtime: Bun.version,
      cpu: cpus()[0]?.model,
      nativeBinary,
      nativeSha256,
      method:
        "Owned temporary fixtures; alternating engines; current-size guard enabled. Includes validation, fresh sizing, native startup/control and deletion. Excludes fixture creation and cleanup. Seven samples are exploratory maxima, not p99 qualification.",
      summary,
      rows,
    },
    null,
    2,
  ) + "\n";
if (values.output) writeFileSync(values.output, output);
process.stdout.write(output);
