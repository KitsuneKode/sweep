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
  { name: "opt-in-patterns", scenario: "opt-in-patterns" as const },
  { name: "classification-context", scenario: "classification-context" as const },
];

/**
 * Default names out of context: a regular file called `target`, an authored
 * `target/` folder with no cargo marker, and a directory named like tsc
 * state must never be presumed safe; a crate's `target`, a tagged custom
 * target dir, a real tsbuildinfo file and a `node_modules` still are.
 */
function seedClassificationContext(root: string): void {
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "target"), "my notes\n");
  mkdirSync(join(root, "notes", "target"), { recursive: true });
  writeFileSync(join(root, "notes", "target", "chapter1.md"), "authored essay\n");
  mkdirSync(join(root, "crate", "target", "debug"), { recursive: true });
  writeFileSync(join(root, "crate", "Cargo.toml"), '[package]\nname = "crate"\n');
  writeFileSync(join(root, "crate", "target", "debug", "app"), "bin\n");
  mkdirSync(join(root, "tagged", "target"), { recursive: true });
  writeFileSync(
    join(root, "tagged", "target", "CACHEDIR.TAG"),
    "Signature: 8a477f597d28d172789f06886806bc55\n",
  );
  mkdirSync(join(root, "app", "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "app", "package.json"), "{}\n");
  writeFileSync(join(root, "app", "node_modules", "pkg", "index.js"), "module.exports = {};\n");
  mkdirSync(join(root, "pkg", "odd.tsbuildinfo"), { recursive: true });
  writeFileSync(join(root, "pkg", "tsconfig.tsbuildinfo"), "{}\n");
}

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
  // Relative, so the committed link is the same in every checkout: an
  // absolute one names this machine's path and dirties CI's tree, which the
  // publish guard then refuses.
  try {
    symlinkSync("dist-target", targetLink, "dir");
  } catch {
    try {
      unlinkSync(targetLink);
    } catch {
      /* ignore */
    }
    symlinkSync("dist-target", targetLink, "dir");
  }
  writeFileSync(join(root, "node_modules", ".gitkeep"), "");
  writeFileSync(join(root, "dist", ".gitkeep"), "");
  writeFileSync(join(root, "dist-target", ".gitkeep"), "");
}

/**
 * Opt-in catalog coverage: `dist`, `build`, and a `*.egg-info` dir that only
 * scan when `request.json` enables them, alongside a default `node_modules`.
 * `dist`/`node_modules` names collide with .gitignore - this fixture exists
 * only via generation, like the other ignored-name trees.
 */
function seedOptInPatterns(root: string): void {
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "build"), { recursive: true });
  mkdirSync(join(root, "pkg.egg-info"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "dist", "bundle.js"), 'console.log("bundled");\n');
  writeFileSync(join(root, "build", "out.js"), "out\n");
  writeFileSync(join(root, "pkg.egg-info", "PKG-INFO"), "Metadata-Version: 2.1\n");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
  writeFileSync(join(root, "src", "index.ts"), "export {};\n");
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

    if (scenario === "opt-in-patterns") {
      seedOptInPatterns(root);
      continue;
    }

    if (scenario === "classification-context") {
      seedClassificationContext(root);
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
