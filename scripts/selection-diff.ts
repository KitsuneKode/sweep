#!/usr/bin/env bun
/**
 * Read-only merge gate for classification changes: scan the same real trees
 * with two built CLIs and diff which paths each pre-selects. Any path the new
 * build selects that the old one did not is a failure - classification may
 * only move toward caution. Never deletes; only `scan --json` runs.
 *
 * Usage:
 *   bun run scripts/selection-diff.ts --old <old sweep.js> [--new <new sweep.js>]
 *     [--engine js|rust] <tree> [<tree>...]
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface Plan {
  candidates: { id: string; path: string; riskTier: string; reasons: string[] }[];
  selectedCandidateIds: string[];
}

function parseArgs(argv: string[]) {
  let oldCli: string | undefined;
  let newCli = resolve(import.meta.dir, "../apps/cli/dist/sweep.js");
  let engine = "js";
  const trees: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--old") oldCli = argv[++i];
    else if (arg === "--new") newCli = argv[++i] ?? newCli;
    else if (arg === "--engine") engine = argv[++i] ?? engine;
    else if (arg !== undefined) trees.push(arg);
  }
  if (!oldCli || trees.length === 0) {
    console.error(
      "usage: selection-diff.ts --old <sweep.js> [--new <sweep.js>] [--engine js|rust] <tree>...",
    );
    process.exit(2);
  }
  return { oldCli: resolve(oldCli), newCli: resolve(newCli), engine, trees };
}

function scan(cli: string, tree: string, engine: string): Plan | string {
  // Large trees produce multi-megabyte plans; a file avoids pipe buffer limits.
  const dir = mkdtempSync(join(tmpdir(), "sweep-selection-diff-"));
  const out = join(dir, "plan.json");
  try {
    const proc = Bun.spawnSync(["bun", cli, "scan", tree, "--json", "--engine", engine], {
      stdout: Bun.file(out),
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return `exit ${proc.exitCode}: ${proc.stderr.toString().trim()}`;
    return JSON.parse(readFileSync(out, "utf8")) as Plan;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function selected(plan: Plan): Map<string, Plan["candidates"][number]> {
  const ids = new Set(plan.selectedCandidateIds);
  return new Map(plan.candidates.filter((c) => ids.has(c.id)).map((c) => [c.path, c]));
}

const { oldCli, newCli, engine, trees } = parseArgs(process.argv.slice(2));
let failed = false;

for (const tree of trees) {
  const before = scan(oldCli, tree, engine);
  const after = scan(newCli, tree, engine);
  if (typeof before === "string" || typeof after === "string") {
    // A refusal on both sides is a consistent guard, not a diff.
    const same = typeof before === "string" && typeof after === "string";
    console.log(
      `${tree}: ${same ? "refused by both" : "MISMATCH"} (old ${typeof before === "string" ? before : "ok"}; new ${typeof after === "string" ? after : "ok"})`,
    );
    if (!same) failed = true;
    continue;
  }
  const oldSelected = selected(before);
  const newSelected = selected(after);
  const added = [...newSelected.keys()].filter((path) => !oldSelected.has(path));
  const removed = [...oldSelected.keys()].filter((path) => !newSelected.has(path));
  console.log(
    `${tree}: ${oldSelected.size} → ${newSelected.size} selected (+${added.length} / -${removed.length})`,
  );
  for (const path of added) {
    failed = true;
    console.log(`  + NEWLY SELECTED ${path}`);
  }
  for (const path of removed) {
    const candidate = after.candidates.find((c) => c.path === path);
    console.log(
      `  - ${path} [${candidate?.riskTier ?? "gone"}: ${candidate?.reasons.join(",") ?? ""}]`,
    );
  }
}

process.exit(failed ? 1 : 0);
