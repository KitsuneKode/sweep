#!/usr/bin/env bun
/**
 * Materialize committed parity fixture directory trees from seed-fixture scenarios.
 *
 * Usage:
 *   bun run scripts/sync-fixture-trees.ts
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const FIXTURES = join(REPO_ROOT, "tests/fixtures");

const SCENARIOS = [
  { name: "node_modules-only", scenario: "node_modules-only" as const },
  { name: "basic", scenario: "basic" as const },
  { name: "monorepo", scenario: "monorepo" as const },
  { name: "workspace-matrix", scenario: "workspace-matrix" as const },
  { name: "risk-mix", scenario: "risk-mix-parity" as const },
];

function seedNodeModulesOnly(root: string): void {
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".gitkeep"), "");
}

/** Default-pattern risk mix: safe dirs + a symlink matching `target`. */
function seedRiskMixParity(root: string): void {
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "dist-target"), { recursive: true });
  const targetLink = join(root, "target");
  try {
    symlinkSync(join(root, "dist-target"), targetLink);
  } catch {
    try {
      unlinkSync(targetLink);
    } catch {
      /* ignore */
    }
    symlinkSync(join(root, "dist-target"), targetLink);
  }
  writeFileSync(join(root, "node_modules", ".gitkeep"), "");
  writeFileSync(join(root, "dist", ".gitkeep"), "");
  writeFileSync(join(root, "dist-target", ".gitkeep"), "");
}

function ensureGitkeeps(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      ensureGitkeeps(path);
      const children = readdirSync(path);
      if (children.length === 0) {
        writeFileSync(join(path, ".gitkeep"), "");
      }
    }
  }
}

function main(): void {
  for (const { name, scenario } of SCENARIOS) {
    const root = join(FIXTURES, name);
    if (scenario === "node_modules-only") {
      seedNodeModulesOnly(root);
      ensureGitkeeps(root);
      continue;
    }

    if (scenario === "risk-mix-parity") {
      seedRiskMixParity(root);
      ensureGitkeeps(root);
      continue;
    }

    const proc = spawnSync(
      Bun.which("bun") ?? "bun",
      ["run", "scripts/seed-fixture.ts", "--", "--scenario", scenario, "--root", root],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );

    if (proc.status !== 0) {
      console.error(proc.stderr || proc.stdout);
      process.exit(proc.status ?? 1);
    }

    ensureGitkeeps(root);
  }

  console.log("synced fixture trees under tests/fixtures/");
}

main();
