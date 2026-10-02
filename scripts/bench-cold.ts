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
 * time the user actually waits), the engine's own elapsedMs, and - on
 * Linux, via `time -v` - the child's file-system inputs (512-byte blocks
 * actually read from storage). A cold run that read ~0 blocks did NOT
 * miss the cache: either the drop didn't take or the fs is RAM-backed.
 * That's the miss/hit validation - timings alone can't prove coldness.
 * Median is the number to trust; cold/warm run interleaved so neither
 * mode owns a luckier cache state. Read-only: this never applies.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
  engineMs: number | undefined;
  candidates: number | undefined;
  /** 512-byte blocks actually read from storage (GNU time). THE miss proof. */
  fsInputs: number | undefined;
  /** Peak RSS in KB (GNU time). */
  maxRssKb: number | undefined;
}

// GNU time (-v) reports "File system inputs" - real block reads from
// storage. Only on Linux; BSD/macOS `time` uses a different -l format.
const TIME_BIN = "/usr/bin/time";
const instrumented = process.platform === "linux" && existsSync(TIME_BIN);

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
  const proc = Bun.spawn(instrumented ? [TIME_BIN, "-v", ...scanArgv()] : scanArgv(), {
    cwd: target,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [code, out, rawErr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const wallMs = performance.now() - start;
  // GNU time report lines are tab-indented; the child's own stderr is not.
  const childErr = rawErr
    .split("\n")
    .filter((l) => !l.startsWith("\t"))
    .join("\n");
  if (code !== 0) throw new Error(`scan exited ${code}: ${childErr.trim().split("\n").pop()}`);
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
    fsInputs: Number(rawErr.match(/File system inputs:\s*(\d+)/)?.[1] ?? NaN) || undefined,
    maxRssKb:
      Number(rawErr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/)?.[1] ?? NaN) ||
      undefined,
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
    if (!last) continue;
    console.log(
      `  ${last.mode}  wall ${last.wallMs.toFixed(0)}ms  engine ${last.engineMs ?? "?"}ms` +
        (last.fsInputs !== undefined ? `  fs-in ${last.fsInputs}` : "") +
        `  ${last.candidates ?? "?"} candidates`,
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
    const inputs = rows.flatMap((r) => (r.fsInputs === undefined ? [] : [r.fsInputs]));
    console.log(
      `\n${mode}: median wall ${median(walls).toFixed(0)}ms  ` +
        `(min ${Math.min(...walls).toFixed(0)} / max ${Math.max(...walls).toFixed(0)})` +
        (engines.length > 0 ? `  ·  engine median ${median(engines).toFixed(0)}ms` : "") +
        (inputs.length > 0 ? `  ·  fs-in median ${median(inputs).toFixed(0)} blocks` : ""),
    );
  }

  // Miss/hit validation: a cold run that read ~0 blocks never touched
  // storage - the drop either failed or the fs is RAM-backed, and the
  // "cold" numbers are warm-comparable. Say so instead of claiming cold.
  if (instrumented) {
    const med = (m: string) => {
      const v = results.flatMap((r) =>
        r.mode === m && r.fsInputs !== undefined ? [r.fsInputs] : [],
      );
      return v.length > 0 ? median(v) : undefined;
    };
    const coldIn = med("cold");
    const warmIn = med("warm");
    console.log("\ncache validation (fs inputs = 512-byte blocks read from storage):");
    if (coldIn === 0 || coldIn === undefined) {
      console.log(
        "  cold runs read ~0 blocks - NOT measurably cold. Either the drop did not\n" +
          "  take or the tree is on RAM-backed storage (tmpfs/overlayfs). Treat these\n" +
          "  numbers as warm-comparable, not first-run cold.",
      );
    } else {
      console.log(
        `  cold median ${coldIn.toFixed(0)} blocks (~${((coldIn * 512) / 1024 / 1024).toFixed(1)} MB)` +
          (warmIn !== undefined ? ` vs warm median ${warmIn.toFixed(0)}` : "") +
          " - real misses confirmed.",
      );
      if (warmIn !== undefined && warmIn > coldIn / 4)
        console.log("  warning: warm runs also read from storage - cache contrast is weak.");
    }
  } else {
    console.log(
      "\nnote: fs-input validation unavailable (needs Linux GNU time) -" +
        " coldness rests on the drop_caches write alone.",
    );
  }
}
