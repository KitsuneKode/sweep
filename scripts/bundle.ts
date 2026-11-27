/**
 * Shared Bun bundler config for publish artifacts in dist/.
 *
 * @see https://bun.com/docs/bundler
 */

import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractNamedImportsFromPackage } from "../apps/cli/scripts/bundle-contract.js";
import { readCatalogs, resolveDependencies } from "../apps/cli/scripts/prepack.js";

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

/** Resolve the `@opentui/core` semver range declared by apps/cli after catalog expansion. */
export function readOpenTuiRequiredRange(): string {
  const pkg = JSON.parse(readFileSync(join(CLI_PACKAGE_DIR, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const catalogs = readCatalogs(REPO_ROOT);
  const optional = resolveDependencies(pkg.optionalDependencies, catalogs);
  const direct = resolveDependencies(pkg.dependencies, catalogs);
  const range = optional?.["@opentui/core"] ?? direct?.["@opentui/core"];
  if (!range) {
    throw new Error("bundle: @opentui/core must be declared in apps/cli/package.json");
  }
  return range;
}

/** Derive the exact named imports `dist/sweep-ui.js` takes from `@opentui/core`. */
export function readOpenTuiRequiredExports(): string[] {
  const uiBundlePath = join(DIST_DIR, "sweep-ui.js");
  if (!existsSync(uiBundlePath)) {
    throw new Error("bundle: dist/sweep-ui.js must be built before cli/lib bundles");
  }
  const source = readFileSync(uiBundlePath, "utf8");
  const exports = extractNamedImportsFromPackage(source, "@opentui/core");
  if (exports.length === 0) {
    throw new Error(
      "bundle: failed to derive any named @opentui/core imports from dist/sweep-ui.js",
    );
  }
  return exports;
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
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const result = await Bun.build({
      sourcemap: "none",
      minify: MINIFY,
      outdir: DIST_DIR,
      throw: true,
      ...options,
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.DEV": '"false"',
        ...options.define,
      },
    });

    reportOutputs(label, result.outputs);
    return result;
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

/**
 * `@opentui/react` ships pre-compiled JS that imports `jsxDEV` from
 * `react/jsx-dev-runtime`. Under `NODE_ENV="production"`, React's prod
 * `jsx-dev-runtime` exports `jsxDEV` as `undefined`, which both leaves `jsxDEV`
 * markers in the bundle and would break `@opentui/react`'s ErrorBoundary if it
 * ever rendered. Rewrite those references to production `jsx` at bundle time.
 */
export const openTuiProdJsxPlugin: Bun.BunPlugin = {
  name: "opentui-react-prod-jsx",
  setup(build) {
    build.onLoad({ filter: /[\\/]@opentui[\\/]react[\\/].*\.js$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      if (!source.includes("jsxDEV")) return undefined;
      const rewritten = source
        .replace(
          /import\s*\{\s*Fragment\s*,\s*jsxDEV\s*\}\s*from\s*["']react\/jsx-dev-runtime["'];?/g,
          'import { Fragment, jsx as _openTuiProdJsx } from "react/jsx-runtime";',
        )
        .replace(/\bjsxDEV\b/g, "_openTuiProdJsx");
      return { contents: rewritten, loader: "js" };
    });
  },
};

/** Lazy-loaded OpenTUI bundle (React + @opentui/react inlined; core stays external). */
export async function buildUiBundle(): Promise<Bun.BuildOutput> {
  return runBundle("ui", {
    entrypoints: [join(REPO_ROOT, "packages/ui/src/app.tsx")],
    target: "bun",
    naming: { entry: "sweep-ui.[ext]" },
    external: ["@opentui/core"],
    plugins: [openTuiProdJsxPlugin],
    root: REPO_ROOT,
    tsconfig: join(REPO_ROOT, "packages/ui/tsconfig.json"),
  });
}

function cliSharedDefines(): Record<string, string> {
  return {
    __SWEEP_VERSION__: JSON.stringify(readCliVersion()),
    __OPENTUI_REQUIRED_RANGE__: JSON.stringify(readOpenTuiRequiredRange()),
    __OPENTUI_REQUIRED_EXPORTS__: JSON.stringify(readOpenTuiRequiredExports()),
  };
}

/** Node CLI bundle; sweep-ui.js is loaded at runtime and stays external. */
export async function buildCliBundle(): Promise<Bun.BuildOutput> {
  const result = await runBundle("cli", {
    entrypoints: [join(REPO_ROOT, "apps/cli/src/bin.ts")],
    target: "node",
    format: "esm",
    naming: { entry: "sweep.[ext]" },
    external: ["@opentui/core", "./sweep-ui.js", "@kitsunekode/sweep-ui"],
    define: cliSharedDefines(),
    banner: `#!/usr/bin/env node\n${NO_COLOR_BOOTSTRAP}\n`,
    root: REPO_ROOT,
    tsconfig: join(REPO_ROOT, "apps/cli/tsconfig.json"),
  });

  const sweepPath = join(DIST_DIR, "sweep.js");
  chmodSync(sweepPath, 0o755);
  return result;
}

/**
 * Programmatic surface (`makeProgram`, `VERSION`) for the published `exports`
 * map. No shebang and no argv bootstrap - importing it must not run the CLI.
 * `sweep-ui.js` still resolves as a sibling of this bundle's import.meta.url.
 */
export async function buildLibBundle(): Promise<Bun.BuildOutput> {
  return runBundle("lib", {
    entrypoints: [join(REPO_ROOT, "apps/cli/src/index.ts")],
    target: "node",
    format: "esm",
    naming: { entry: "sweep-lib.[ext]" },
    external: ["@opentui/core", "./sweep-ui.js", "@kitsunekode/sweep-ui"],
    define: cliSharedDefines(),
    root: REPO_ROOT,
    tsconfig: join(REPO_ROOT, "apps/cli/tsconfig.json"),
  });
}

export async function buildAllBundles(): Promise<void> {
  console.log("bundling sweep publish artifacts\n");
  await buildUiBundle();
  await buildCliBundle();
  await buildLibBundle();
  console.log("\ndone: apps/cli/dist/sweep.js + sweep-ui.js + sweep-lib.js");
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
    if (target === "lib") {
      await buildLibBundle();
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
