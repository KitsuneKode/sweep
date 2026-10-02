#!/usr/bin/env bun
/**
 * True cold-start scan benchmark - the numbers a first-run user gets.
 *
 * Dropping the page cache requires root, so run under sudo; the spawned
 * sweep process still inherits your HOME/PATH, so config resolution and the
 * scan itself behave exactly like a normal invocation.
 *
 *   sudo bun run scripts/bench-cold.ts ~/Projects
 *   sudo bun run scripts/bench-cold.ts ~/Projects --runs 7 --engine js
 *   sudo bun run scripts/bench-cold.ts ~/Projects --both   # interleave warm
 *   sudo bun run scripts/bench-cold.ts ~/Projects --bin ./sweep  # standalone
 *
 * Per run it reports wall time (spawn + module load + scan + print - the
 * time the user actually waits) and the engine's own elapsedMs from
 * scan_completed. Median is the number to trust; cold/warm run interleaved
 * so neither mode owns a luckier cache state. Read-only: this never applies.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tryDropPageCache } from "../packages/core/src/cold.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const jsonOut = argv.includes("--json");
const both = argv.includes("--both");
const runs = Math.max(1, Number(flagValue("runs") ?? 5));
const engine = flagValue("engine") ?? "auto";
const binFlag = flagValue("bin");
const FLAGS_WITH_VALUE = new Set(["runs", "engine", "bin"]);
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && !FLAGS_WITH_VALUE.has(argv[i - 1]?.replace(/^--/, "") ?? ""),
);
const target = resolve(positional[0] ?? ".");

// Every mode runs cold iterations; cold needs root to drop the cache.
if (typeof process.geteuid === "function" && process.geteuid() !== 0) {
  console.error(
    "bench-cold needs root to drop page cache.\n" +
      "  Run:  sudo bun run scripts/bench-cold.ts <dir>\n" +
      "  Or measure the warm side only: bun run bench -- <dir>",
  );
  process.exit(1);
}

interface RunResult {
  mode: "cold" | "warm";
  /** Wall clock: spawn + module load + scan + print. What a user waits for. */
  wallMs: number;
  /** Engine-internal scan time reported by scan_completed. */
  engineMs?: number;
  candidates?: number;
}

function scanArgv(): string[] {
  // --bin: an executable sweep (standalone build or a wrapper on PATH).
  // Default: the dev entrypoint - same code path as `bun run dev`.
  const base =
    binFlag !== undefined
      ? [resolve(binFlag)]
      : [process.execPath, join(REPO_ROOT, "apps/cli/src/bin.ts")];
  return [...base, "scan", target, "--json-stream", "--engine", engine];
}

async function runOnce(mode: "cold" | "warm"): Promise<RunResult> {
  let dropped = true;
  if (mode === "cold") {
    const drop = tryDropPageCache();
    dropped = drop.dropped;
    if (!dropped && !jsonOut)
      console.error(`  note: ${drop.detail} - this run is not actually cold`);
  }
  const start = performance.now();
  const proc = Bun.spawn(scanArgv(), {
    cwd: target,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const wallMs = performance.now() - start;
  if (code !== 0) throw new Error(`scan exited ${code}: ${err.trim().split("\n").pop()}`);
  const completed = out
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as { type: string; summary?: Record<string, number> })
    .find((e) => e.type === "scan_completed");
  return {
    mode,
    wallMs,
    engineMs: completed?.summary?.elapsedMs,
    candidates: completed?.summary?.candidateCount,
  };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2 : (s[m] ?? 0);
}

const results: RunResult[] = [];
for (let i = 0; i < runs; i++) {
  results.push(await runOnce("cold"));
  if (both) results.push(await runOnce("warm"));
  if (!jsonOut) {
    const last = results[results.length - 1];
    console.log(
      `  ${last.mode}  wall ${last.wallMs.toFixed(0)}ms  engine ${last.engineMs ?? "?"}ms  ${last.candidates ?? "?"} candidates`,
    );
  }
}

if (jsonOut) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const mode of both ? (["cold", "warm"] as const) : (["cold"] as const)) {
    const rows = results.filter((r) => r.mode === mode);
    if (rows.length === 0) continue;
    const walls = rows.map((r) => r.wallMs);
    const engines = rows.flatMap((r) => (r.engineMs === undefined ? [] : [r.engineMs]));
    console.log(
      `\n${mode}: median wall ${median(walls).toFixed(0)}ms  ` +
        `(min ${Math.min(...walls).toFixed(0)} / max ${Math.max(...walls).toFixed(0)})` +
        (engines.length > 0 ? `  ·  engine median ${median(engines).toFixed(0)}ms` : ""),
    );
  }
}
