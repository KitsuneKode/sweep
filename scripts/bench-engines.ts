#!/usr/bin/env bun
/**
 * Engine A/B benchmark: times the same trees under the JS scanner and the
 * Rust sweep-engine subprocess.
 *
 * Runs are interleaved (js, rust, js, rust, …) after one warmup each, so page
 * cache and filesystem-order bias land evenly on both engines. Report the
 * median - mean is noise bait on shared machines.
 *
 * Usage:
 *   bun run bench                          # every tests/fixtures/ tree, 5 runs
 *   bun run bench -- tests/fixtures/monorepo --runs 9
 *   bun run bench -- --json                # machine-readable rows on stdout
 *   bun run bench -- --cold                # drop page cache before every run
 *   bun run bench -- --synth /tmp/big      # generate a big tree, then bench it
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tryDropPageCache } from "@kitsunekode/sweep-core/cold";
import { DEFAULT_CONFIG } from "@kitsunekode/sweep-core/config";
import { scanToPlan } from "@kitsunekode/sweep-core/engine";
import { isRustEngineAvailable, scanToPlanViaRust } from "@kitsunekode/sweep-core/rust-engine";

interface BenchRow {
  tree: string;
  engine: "js" | "rust";
  /** Median elapsed across runs. */
  medianMs: number;
  minMs: number;
  maxMs: number;
  candidates: number;
  /** FNV-1a over sorted candidate paths - a set fingerprint for parity. */
  paths: string;
  scannedDirs: number;
  skippedDirs: number;
  runs: number;
  /**
   * Present under --cold: how many runs started on a genuinely dropped page
   * cache. drops < runs means some "cold" rows still ran warm - read the
   * numbers accordingly, the bench never relabels warm as cold.
   */
  coldDrops?: number;
}

const argv = process.argv.slice(2);
const FLAGS_WITH_VALUE = new Set(["runs", "synth"]);
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const jsonOut = argv.includes("--json");
const cold = argv.includes("--cold");
const runs = Math.max(1, Number(flagValue("runs") ?? 5));
const synthDir = flagValue("synth");
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && !FLAGS_WITH_VALUE.has(argv[i - 1]?.replace(/^--/, "") ?? ""),
);

const DEFAULT_SELECTION_POLICY = { mode: "default" as const, includeDangerous: false };

/** FNV-1a hash - cheap deterministic fingerprint for candidate-set parity. */
function hashPaths(candidates: Array<{ path: string }>): string {
  let hash = 0x811c9dc5;
  for (const p of candidates.map((c) => c.path).sort()) {
    for (let i = 0; i < p.length; i++) {
      hash ^= p.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

async function timeJs(
  targetDir: string,
): Promise<{ ms: number; plan: Awaited<ReturnType<typeof scanToPlan>>["plan"] }> {
  const start = performance.now();
  const { plan } = await scanToPlan(targetDir, DEFAULT_CONFIG, {
    selectionPolicy: DEFAULT_SELECTION_POLICY,
  });
  return { ms: performance.now() - start, plan };
}

async function timeRust(
  targetDir: string,
): Promise<{ ms: number; plan: Awaited<ReturnType<typeof scanToPlanViaRust>> }> {
  const start = performance.now();
  const plan = await scanToPlanViaRust(targetDir, {
    config: DEFAULT_CONFIG,
    selectionPolicy: DEFAULT_SELECTION_POLICY,
    exact: false,
  });
  return { ms: performance.now() - start, plan };
}

/** Deep-ish tree: N projects, each with nested package dirs holding node_modules/dist/build. */
function synthTree(root: string, projects = 24, depth = 3): void {
  mkdirSync(root, { recursive: true });
  const targets = ["node_modules", "dist", "build", "coverage"];
  for (let p = 0; p < projects; p++) {
    const pkg = join(root, `pkg-${String(p).padStart(3, "0")}`);
    let dir = pkg;
    for (let d = 0; d < depth; d++) {
      dir = join(dir, `level-${d}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.ts"), `// ${dir}\n`);
      for (const target of targets) {
        const t = join(dir, target);
        mkdirSync(t, { recursive: true });
        writeFileSync(join(t, "chunk.js"), "x".repeat(1024));
      }
    }
    mkdirSync(join(pkg, "node_modules"), { recursive: true });
    writeFileSync(join(pkg, "node_modules", "dep.js"), "x".repeat(2048));
  }
}

async function benchTree(tree: string, targetDir: string, rustOk: boolean): Promise<BenchRow[]> {
  const engines: Array<
    [
      "js" | "rust",
      () => Promise<{
        ms: number;
        plan: {
          candidates: Array<{ path: string }>;
          summary: { scannedDirs: number; skippedDirs?: number };
        };
      }>,
    ]
  > = [["js", () => timeJs(targetDir)]];
  if (rustOk) engines.push(["rust", () => timeRust(targetDir)]);

  // One warmup per engine so run 1 doesn't carry cold-cache cost for one side.
  for (const [, run] of engines) await run();

  const samples = new Map<
    "js" | "rust",
    {
      times: number[];
      coldDrops: number;
      lastPlan: {
        candidates: Array<{ path: string }>;
        summary: { scannedDirs: number; skippedDirs?: number };
      };
    }
  >();
  for (const [engine] of engines)
    samples.set(engine, {
      times: [],
      coldDrops: 0,
      lastPlan: { candidates: [], summary: { scannedDirs: 0 } },
    });

  // Interleave so a warming cache doesn't belong to whichever engine ran first.
  for (let i = 0; i < runs; i++) {
    for (const [engine, run] of engines) {
      if (cold && tryDropPageCache().dropped) samples.get(engine)!.coldDrops++;
      const { ms, plan } = await run();
      const bucket = samples.get(engine)!;
      bucket.times.push(ms);
      bucket.lastPlan = plan;
    }
  }

  return [...samples.entries()].map(([engine, { times, coldDrops, lastPlan }]) => ({
    tree,
    engine,
    medianMs: Math.round(median(times)),
    minMs: Math.round(Math.min(...times)),
    maxMs: Math.round(Math.max(...times)),
    candidates: lastPlan.candidates.length,
    paths: hashPaths(lastPlan.candidates),
    scannedDirs: lastPlan.summary.scannedDirs,
    skippedDirs: lastPlan.summary.skippedDirs ?? 0,
    runs: times.length,
    ...(cold ? { coldDrops } : {}),
  }));
}

function printTable(rows: BenchRow[]): void {
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  console.log(
    `${"tree".padEnd(24)} ${pad("engine", 6)} ${pad("median", 8)} ${pad("min", 8)} ${pad("max", 8)} ${pad("cands", 6)} ${pad("dirs", 6)} ${pad("runs", 4)}`,
  );
  for (const row of rows) {
    const dropNote = row.coldDrops === undefined ? "" : ` drops:${row.coldDrops}/${row.runs}`;
    console.log(
      `${row.tree.padEnd(24)} ${pad(row.engine, 6)} ${pad(`${row.medianMs}ms`, 8)} ${pad(`${row.minMs}ms`, 8)} ${pad(`${row.maxMs}ms`, 8)} ${pad(row.candidates, 6)} ${pad(row.scannedDirs, 6)} ${pad(row.runs, 4)}${dropNote}`,
    );
  }
  if (cold && rows.some((r) => (r.coldDrops ?? 0) < r.runs)) {
    console.error(
      "note: --cold requested but some runs could not drop page cache (needs root on Linux); those timings are warm-cache",
    );
  }
  // Pair js/rust rows per tree for the verdict line.
  for (const tree of new Set(rows.map((r) => r.tree))) {
    const js = rows.find((r) => r.tree === tree && r.engine === "js");
    const rs = rows.find((r) => r.tree === tree && r.engine === "rust");
    if (!js || !rs) continue;
    const ratio = rs.medianMs > 0 ? js.medianMs / rs.medianMs : 0;
    const verdict =
      ratio > 1.05
        ? `rust ${ratio.toFixed(1)}× faster`
        : ratio < 0.95
          ? `js ${(1 / ratio).toFixed(1)}× faster`
          : "about equal";
    // Counts alone can hide swapped/duplicated candidates - compare sets.
    const parity =
      js.candidates === rs.candidates && js.paths === rs.paths
        ? "parity ✓"
        : `PARITY MISMATCH js=${js.candidates} rust=${rs.candidates}`;
    console.log(`  ${tree}: ${verdict} · ${parity}`);
  }
}

async function main(): Promise<void> {
  // The argv flag also bridges to the env read sites so the engine probe
  // memo stops answering from cache inside this process too.
  if (cold) process.env.SWEEP_COLD = "1";
  if (synthDir) {
    const target = resolve(synthDir);
    synthTree(target);
    if (!jsonOut) console.log(`synthesized tree at ${target}`);
  }

  const trees: Array<[string, string]> = [];
  if (positional.length > 0) {
    for (const arg of positional) trees.push([arg, resolve(arg)]);
  } else {
    const fixturesRoot = resolve("tests/fixtures");
    for (const entry of readdirSync(fixturesRoot, { withFileTypes: true })) {
      if (entry.isDirectory())
        trees.push([`tests/fixtures/${entry.name}`, join(fixturesRoot, entry.name)]);
    }
  }
  if (synthDir) trees.push([`synth:${synthDir}`, resolve(synthDir)]);

  const rustOk = isRustEngineAvailable();
  if (!rustOk && !jsonOut) {
    console.error(
      "note: sweep-engine binary not found - benchmarking js only (run `bun run engine:build` first)",
    );
  }

  const rows: BenchRow[] = [];
  for (const [name, dir] of trees) {
    if (!existsSync(dir)) {
      console.error(`skip ${name}: not a directory`);
      continue;
    }
    rows.push(...(await benchTree(name, dir, rustOk)));
  }

  if (jsonOut) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    printTable(rows);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
