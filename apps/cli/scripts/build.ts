import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (published `dist/` lives here). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIST = join(REPO_ROOT, "dist");
const OUT = join(DIST, "sweep.js");
const UI_OUT = join(DIST, "sweep-ui.js");

const OPENTUI_EXTERNAL: Array<string | RegExp> = ["@opentui/core", /^@opentui\/core-/];

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  version: string;
};

const buildOptions = {
  target: "node" as const,
  minify: {
    whitespace: true,
    syntax: true,
    identifiers: false,
  },
  sourcemap: "none" as const,
  splitting: false,
};

console.log("Building sweep...");

const [mainResult, uiResult] = await Promise.all([
  Bun.build({
    entrypoints: [join(REPO_ROOT, "apps/cli/src/bin.ts")],
    outdir: DIST,
    ...buildOptions,
    naming: "sweep.js",
    external: [...OPENTUI_EXTERNAL, "./sweep-ui.js"] as string[],
    define: {
      __SWEEP_VERSION__: JSON.stringify(pkg.version),
    },
  }),
  Bun.build({
    entrypoints: [join(REPO_ROOT, "packages/ui/src/app.ts")],
    outdir: DIST,
    ...buildOptions,
    naming: "sweep-ui.js",
    external: OPENTUI_EXTERNAL as string[],
  }),
]);

if (!mainResult.success) {
  console.error("Main build failed:");
  for (const log of mainResult.logs) console.error(" ", log);
  process.exit(1);
}

if (!uiResult.success) {
  console.error("UI build failed:");
  for (const log of uiResult.logs) console.error(" ", log);
  process.exit(1);
}

const content = readFileSync(OUT, "utf8");
const preamble = [
  "#!/usr/bin/env node",
  "if(process.argv.includes('--no-color'))process.env['NO_COLOR']='1';",
].join("\n");
writeFileSync(OUT, `${preamble}\n${content}`);
chmodSync(OUT, 0o755);

const sizeKB = (Bun.file(OUT).size / 1024).toFixed(1);
const uiSizeKB = (Bun.file(UI_OUT).size / 1024).toFixed(1);

console.log(`✓ dist/sweep.js  (${sizeKB} KB)`);
console.log(`✓ dist/sweep-ui.js  (${uiSizeKB} KB)`);
if (!existsSync(UI_OUT)) {
  console.error("UI bundle missing after build");
  process.exit(1);
}
