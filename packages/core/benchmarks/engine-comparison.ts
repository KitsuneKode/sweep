#!/usr/bin/env bun
/** Warm-cache API benchmark, including the Rust process and streaming bridge. */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { cpus, platform, arch, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DEFAULT_SELECTION_POLICY, type ScanPlan } from "@kitsunekode/sweep-protocol";
import { DEFAULT_CONFIG } from "../src/config.js";
import { scanToPlan } from "../src/engine.js";
import { scanToPlanViaRust } from "../src/rust-engine.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    samples: { type: "string", default: "100" },
    warmups: { type: "string", default: "3" },
    output: { type: "string" },
    scenarios: { type: "string", default: "small,wide,dense,fat" },
    "fat-files": { type: "string", default: "20000" },
    "fixture-parent": { type: "string" },
    "resource-samples": { type: "string", default: "0" },
  },
});
const samples = Number(values.samples);
const warmups = Number(values.warmups);
const fatFiles = Number(values["fat-files"]);
const resourceSamples = Number(values["resource-samples"]);
if (!Number.isInteger(resourceSamples) || resourceSamples < 0 || resourceSamples > 10)
  throw new Error("resource-samples must be 0–10");
if (resourceSamples > 0 && (platform() !== "linux" || !existsSync("/usr/bin/time")))
  throw new Error("resource sampling requires Linux /usr/bin/time");
if (
  !Number.isInteger(samples) ||
  samples < 1 ||
  samples > 10000 ||
  !Number.isInteger(warmups) ||
  warmups < 0 ||
  warmups > 100
) {
  throw new Error("samples must be 1–10000 and warmups 0–100");
}
if (!Number.isInteger(fatFiles) || fatFiles < 1 || fatFiles > 1000000)
  throw new Error("fat-files must be 1–1000000");
const binary = resolve(
  process.env.SWEEP_ENGINE_PATH ?? join(import.meta.dir, "../../../target/release/sweep-engine"),
);
if (!existsSync(binary)) throw new Error("Build the release engine first: bun run engine:build");
process.env.SWEEP_ENGINE_PATH = binary;
const availableScenarios = [
  { name: "small", candidates: 32, files: 8 },
  { name: "wide", candidates: 1024, files: 3 },
  { name: "dense", candidates: 32, files: 256 },
  { name: "fat", candidates: 1, files: fatFiles },
  { name: "flat", candidates: 1, files: fatFiles },
];
const requested = values.scenarios!.split(",");
if (requested.some((name) => !availableScenarios.some((scenario) => scenario.name === name)))
  throw new Error("scenarios must be a comma-separated list of small,wide,dense,fat,flat");
const scenarios = availableScenarios.filter((scenario) => requested.includes(scenario.name));
type Sample = {
  total: number;
  first: number;
  sized: number;
  maxLag: number;
  bytes: number;
  count: number;
};
const metrics = ["total", "first", "sized", "maxLag"] as const;
const percentile = (values: number[], p: number) =>
  values.slice().sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!;
const rows: Array<Record<string, unknown>> = [];
const raw: Record<string, Record<"js" | "rust", Sample[]>> = {};
const du: Record<string, { bytes: number; elapsedMs: number }> = {};
const resources: Array<Record<string, unknown>> = [];
const parent = resolve(values["fixture-parent"] ?? tmpdir());
const root = mkdtempSync(join(parent, "sweep-benchmark-"));
try {
  for (const scenario of scenarios) {
    const path = join(root, scenario.name);
    for (let i = 0; i < scenario.candidates; i++) {
      const artifact = join(path, `group-${i % 16}`, `pkg-${i}`, "node_modules");
      mkdirSync(artifact, { recursive: true });
      for (let j = 0; j < scenario.files; j++) {
        const fileDir =
          scenario.name === "fat" ? join(artifact, `dep-${Math.floor(j / 64)}`) : artifact;
        if (j % 64 === 0 && scenario.name === "fat") mkdirSync(fileDir, { recursive: true });
        writeFileSync(join(fileDir, `f-${j}.bin`), Buffer.alloc(128, (i + j) % 255));
      }
    }
    if (platform() === "linux" && scenario.candidates === 1) {
      const started = performance.now();
      const output = execFileSync("du", ["-sb", "--", join(path, "group-0/pkg-0/node_modules")], {
        encoding: "utf8",
      });
      du[scenario.name] = {
        bytes: Number(output.split("\t")[0]),
        elapsedMs: performance.now() - started,
      };
    }
    for (const exact of [false, true]) {
      const results: Record<"js" | "rust", Sample[]> = { js: [], rust: [] };
      let expected: string | undefined;
      let expectedBytes: number | undefined;
      for (let iteration = -warmups; iteration < samples; iteration++) {
        const engines: Array<"js" | "rust"> = iteration % 2 === 0 ? ["js", "rust"] : ["rust", "js"];
        for (const engine of engines) {
          let first: number | undefined;
          let sized: number | undefined;
          let maxLag = 0;
          const started = performance.now();
          let previous = started;
          const timer = setInterval(() => {
            const now = performance.now();
            maxLag = Math.max(maxLag, now - previous - 5);
            previous = now;
          }, 5);
          let plan: ScanPlan;
          try {
            const options = {
              exact,
              selectionPolicy: DEFAULT_SELECTION_POLICY,
              onEntry: () => {
                first ??= performance.now() - started;
              },
              onEntrySized: () => {
                sized ??= performance.now() - started;
              },
            };
            plan =
              engine === "js"
                ? (await scanToPlan(path, DEFAULT_CONFIG, options)).plan
                : await scanToPlanViaRust(path, { config: DEFAULT_CONFIG, ...options });
          } finally {
            clearInterval(timer);
          }
          const total = performance.now() - started;
          const signature = JSON.stringify(
            plan.candidates
              .map((candidate) => [
                candidate.path,
                candidate.entryType,
                candidate.isSymlink,
                candidate.riskTier,
                candidate.selectedByDefault,
              ])
              .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          );
          expected ??= signature;
          if (
            signature !== expected ||
            plan.candidates.length !== scenario.candidates ||
            first === undefined ||
            sized === undefined
          )
            throw new Error(`Candidate/stream parity failed: ${scenario.name} ${engine}`);
          {
            expectedBytes ??= plan.summary.estimatedTotalBytes;
            if (expectedBytes !== plan.summary.estimatedTotalBytes)
              throw new Error(`Byte parity failed: ${scenario.name} ${engine}`);
          }
          if (
            !exact &&
            du[scenario.name] &&
            plan.summary.estimatedTotalBytes !== du[scenario.name]!.bytes
          )
            throw new Error(`GNU du byte parity failed: ${scenario.name} ${engine}`);
          if (iteration >= 0)
            results[engine].push({
              total,
              first,
              sized,
              maxLag,
              count: plan.candidates.length,
              bytes: plan.summary.estimatedTotalBytes,
            });
        }
      }
      raw[`${scenario.name}-${exact ? "exact" : "estimated"}`] = results;
      for (const engine of ["js", "rust"] as const) {
        const data = results[engine];
        const row: Record<string, unknown> = {
          scenario: scenario.name,
          exact,
          engine,
          candidates: scenario.candidates,
          estimatedBytes: data[0]!.bytes,
        };
        for (const metric of metrics)
          row[metric] = Object.fromEntries(
            [0.5, 0.95, 0.99].map((p) => [
              `p${Math.round(p * 100)}`,
              +percentile(
                data.map((sample) => sample[metric]),
                p,
              ).toFixed(2),
            ]),
          );
        rows.push(row);
        console.error(JSON.stringify(row));
        for (let resourceIteration = 0; resourceIteration < resourceSamples; resourceIteration++) {
          const report = join(root, "resource-report.txt");
          const summary = JSON.parse(
            execFileSync(
              "/usr/bin/time",
              [
                "-v",
                "-o",
                report,
                process.execPath,
                join(import.meta.dir, "engine-resource-sample.ts"),
                engine,
                path,
                String(exact),
                binary,
              ],
              { encoding: "utf8" },
            ),
          ) as ScanPlan["summary"];
          if (summary.candidateCount !== scenario.candidates)
            throw new Error("Resource probe candidate parity failed");
          const measured = await Bun.file(report).text();
          const rssKiB = Number(measured.match(/Maximum resident set size \(kbytes\): (\d+)/)?.[1]);
          if (!Number.isFinite(rssKiB)) throw new Error("Could not parse GNU time RSS");
          resources.push({ scenario: scenario.name, exact, engine, rssKiB, report: measured });
        }
      }
    }
  }
  const result = {
    date: new Date().toISOString(),
    runtime: Bun.version,
    os: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    binary,
    binarySha256: createHash("sha256")
      .update(new Uint8Array(await Bun.file(binary).arrayBuffer()))
      .digest("hex"),
    fixtureParent: parent,
    du,
    resources,
    resourceMethod:
      "Separate fresh Bun processes using the same streaming APIs, measured with GNU time -v. Max RSS is per-process high-water accounting, not the sum of simultaneous host, Rust and du RSS; includes startup. Does not prove absence of leaks.",
    samples,
    warmups,
    method:
      "Alternating engines; warm filesystem cache; API scan-to-plan including Rust spawn, NDJSON and JS planning; no CLI startup, rendering, apply, cold-cache or memory measurement. p99 is empirical nearest rank, not a production guarantee. maxLag uses a 5 ms heartbeat and misses stalls shorter than a scan.",
    scenarios,
    rows,
    raw,
  };
  const json = JSON.stringify(result, null, 2) + "\n";
  if (values.output) writeFileSync(values.output, json);
  else process.stdout.write(json);
} finally {
  rmSync(root, { recursive: true, force: true });
}
