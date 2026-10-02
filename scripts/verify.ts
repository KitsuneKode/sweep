#!/usr/bin/env bun
/**
 * One-command verification ladder: every check the repo can run, ordered
 * fast-first, collected into a single honest report.
 *
 *   bun run verify                  # dev tier - the local gate before push
 *   bun run verify -- --all         # dev + release tiers (pack, preflight, standalone smoke)
 *   bun run verify -- --fail-fast   # stop at the first failure
 *   bun run verify -- --step rust   # run only steps whose name contains "rust"
 *   bun run verify -- --json        # machine-readable report on stdout
 *
 * Every step reports pass/fail/skip - skips carry a reason so a missing
 * artifact is visible rather than silently green. Exit code is nonzero when
 * anything fails; skips never fail the run.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const argv = process.argv.slice(2);
const all = argv.includes("--all");
const failFast = argv.includes("--fail-fast");
const jsonOut = argv.includes("--json");
const stepFilter = (() => {
  const i = argv.indexOf("--step");
  return i >= 0 ? argv[i + 1]?.toLowerCase() : undefined;
})();

interface Step {
  name: string;
  cmd: string[];
  /** Release-tier steps only run under --all. */
  release?: boolean;
  /** Return a skip reason, or false to run. */
  unless?: () => string | false;
}

const engineBin = () =>
  ["release", "debug"]
    .map((p) =>
      join(
        REPO_ROOT,
        "target",
        p,
        process.platform === "win32" ? "sweep-engine.exe" : "sweep-engine",
      ),
    )
    .find(existsSync);

const steps: Step[] = [
  { name: "fixtures:sync", cmd: ["bun", "run", "fixtures:sync"] },
  { name: "fixtures:validate-goldens", cmd: ["bun", "run", "fixtures:validate-goldens"] },
  // `check` already runs fmt+lint+typecheck+all workspace tests+doc links.
  { name: "check", cmd: ["bun", "run", "check"] },
  { name: "rust:check", cmd: ["bun", "run", "rust:check"] },
  {
    name: "engine:verify",
    cmd: ["bun", "run", "engine:verify"],
    unless: () =>
      engineBin() === undefined && "no sweep-engine binary (bun run engine:build first)",
  },
  {
    name: "preflight",
    cmd: ["bunx", "turbo", "run", "preflight", "--filter", "@kitsunekode/sweep"],
    release: true,
  },
  { name: "pack:preview", cmd: ["bun", "run", "pack:preview"], release: true },
  {
    name: "standalone smoke",
    release: true,
    // Build to a temp outfile, then scan a fixture with an empty PATH - the
    // embedded engine must do the work with nothing external on PATH.
    cmd: ["bun", "run", "scripts/verify-standalone.ts"],
    unless: () =>
      engineBin()?.includes("release")
        ? false
        : "no release sweep-engine (bun run engine:build first)",
  },
];

interface StepResult {
  name: string;
  status: "pass" | "fail" | "skip";
  ms: number;
  detail?: string;
  outputTail?: string;
}

async function runStep(step: Step): Promise<StepResult> {
  const start = performance.now();
  const proc = Bun.spawn(step.cmd, {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const ms = performance.now() - start;
  if (code === 0) return { name: step.name, status: "pass", ms };
  const tail = `${out}\n${err}`.trim().split("\n").slice(-40).join("\n");
  return { name: step.name, status: "fail", ms, detail: `exit ${code}`, outputTail: tail };
}

const selected = steps.filter(
  (s) => (!s.release || all) && (stepFilter === undefined || s.name.includes(stepFilter)),
);

const results: StepResult[] = [];
for (const step of selected) {
  const skip = step.unless?.();
  if (skip) {
    results.push({ name: step.name, status: "skip", ms: 0, detail: skip });
    if (!jsonOut) console.log(`  -  ${step.name} (skipped: ${skip})`);
    continue;
  }
  if (!jsonOut) console.log(`▶ ${step.name}`);
  const result = await runStep(step);
  results.push(result);
  if (!jsonOut) {
    const mark = result.status === "pass" ? "✓" : "✗";
    console.log(`  ${mark}  ${step.name} (${(result.ms / 1000).toFixed(1)}s)`);
    if (result.outputTail !== undefined) {
      console.log(`  --- last lines ---\n${result.outputTail}\n  ------------------`);
    }
  }
  if (result.status === "fail" && failFast) break;
}

const failed = results.filter((r) => r.status === "fail");
if (jsonOut) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(
    `\n${results
      .map((r) => `  ${r.status === "pass" ? "✓" : r.status === "skip" ? "-" : "✗"}  ${r.name}`)
      .join("\n")}`,
  );
  console.log(
    failed.length === 0
      ? `\nverify: all ${results.filter((r) => r.status === "pass").length} steps passed`
      : `\nverify: ${failed.length} failed - ${failed.map((r) => r.name).join(", ")}`,
  );
}
process.exit(failed.length === 0 ? 0 : 1);
