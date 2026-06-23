/**
 * Shared Bun bundler config for publish artifacts in dist/.
 *
 * @see https://bun.com/docs/bundler
 */

import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..");
export const CLI_PACKAGE_DIR = join(REPO_ROOT, "apps/cli");
export const DIST_DIR = join(CLI_PACKAGE_DIR, "dist");

const MINIFY = {
  syntax: true,
  whitespace: true,
} as const;

const NO_COLOR_BOOTSTRAP = 'if(process.argv.includes("--no-color"))process.env["NO_COLOR"]="1";';

export function readCliVersion(): string {
  const pkg = JSON.parse(readFileSync(join(CLI_PACKAGE_DIR, "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

function ensureDistDir(): void {
  mkdirSync(DIST_DIR, { recursive: true });
}

function reportOutputs(label: string, outputs: Bun.BuildOutput["outputs"]): void {
  for (const artifact of outputs) {
    const kb = (artifact.size / 1024).toFixed(1);
    console.log(`  ${label}: ${artifact.path} (${kb} KB)`);
  }
}

async function runBundle(
  label: string,
  options: Omit<Bun.BuildConfig, "outdir"> & { outdir?: string },
): Promise<Bun.BuildOutput> {
  ensureDistDir();

  const result = await Bun.build({
    sourcemap: "none",
    minify: MINIFY,
    outdir: DIST_DIR,
    throw: true,
    ...options,
  });

  reportOutputs(label, result.outputs);
  return result;
}

/** Lazy-loaded OpenTUI bundle (React + @opentui/react inlined; core stays external). */
export async function buildUiBundle(): Promise<Bun.BuildOutput> {
  return runBundle("ui", {
    entrypoints: [join(REPO_ROOT, "packages/ui/src/app.tsx")],
    target: "bun",
    naming: { entry: "sweep-ui.[ext]" },
    external: ["@opentui/core"],
    root: REPO_ROOT,
    tsconfig: join(REPO_ROOT, "packages/ui/tsconfig.json"),
  });
}

/** Node CLI bundle; sweep-ui.js is loaded at runtime and stays external. */
export async function buildCliBundle(): Promise<Bun.BuildOutput> {
  const version = readCliVersion();

  const result = await runBundle("cli", {
    entrypoints: [join(REPO_ROOT, "apps/cli/src/bin.ts")],
    target: "node",
    format: "esm",
    naming: { entry: "sweep.[ext]" },
    external: ["@opentui/core", "./sweep-ui.js", "@kitsunekode/sweep-ui"],
    define: {
      __SWEEP_VERSION__: JSON.stringify(version),
    },
    banner: `#!/usr/bin/env node\n${NO_COLOR_BOOTSTRAP}\n`,
    root: REPO_ROOT,
    tsconfig: join(REPO_ROOT, "apps/cli/tsconfig.json"),
  });

  const sweepPath = join(DIST_DIR, "sweep.js");
  chmodSync(sweepPath, 0o755);
  return result;
}

export async function buildAllBundles(): Promise<void> {
  console.log("bundling sweep publish artifacts\n");
  await buildUiBundle();
  await buildCliBundle();
  console.log("\ndone — apps/cli/dist/sweep.js + apps/cli/dist/sweep-ui.js");
}

if (import.meta.main) {
  const target = process.argv[2] ?? "all";
  const watch = process.argv.includes("--watch");

  async function run(): Promise<void> {
    if (target === "ui") {
      await buildUiBundle();
      return;
    }
    if (target === "cli") {
      await buildCliBundle();
      return;
    }
    if (target === "all") {
      await buildAllBundles();
      return;
    }
    console.error(`unknown target: ${target} (expected ui | cli | all)`);
    process.exit(1);
  }

  if (watch) {
    console.log(`watching bundle target: ${target}\n`);
    await run();
    const { watch: fsWatch } = await import("node:fs");
    const sources = [
      join(REPO_ROOT, "apps/cli/src"),
      join(REPO_ROOT, "packages/ui/src"),
      join(REPO_ROOT, "packages/core/src"),
      join(REPO_ROOT, "packages/display/src"),
      join(REPO_ROOT, "packages/protocol/src"),
      join(REPO_ROOT, "scripts/bundle.ts"),
    ];
    for (const dir of sources) {
      fsWatch(dir, { recursive: true }, () => {
        void run().catch((err: unknown) => {
          console.error(err);
        });
      });
    }
  } else {
    await run();
  }
}
