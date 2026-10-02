import { join } from "node:path";
import { existsSync } from "node:fs";
import { REPO_ROOT, readCliVersion } from "./bundle.js";

// Standalone executables require the `--compile` flag on Bun's CLI - the
// JS API (Bun.build) emits plain JS bundles, not embedded executables.
// See https://bun.com/docs/bundler/executables

const version = readCliVersion();
const target = process.argv[2];
const outfile = process.argv[3] ?? "sweep";
const entry = join(REPO_ROOT, "apps/cli/src/bin-standalone.ts");
const nativeAsset = `target/release/sweep-engine${process.platform === "win32" ? ".exe" : ""}`;
if (!existsSync(join(REPO_ROOT, nativeAsset))) {
  throw new Error("Build the host Rust engine first: bun run engine:build");
}
if (
  target &&
  target !== `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
) {
  throw new Error("Standalone builds must run on the target platform to embed its native engine");
}

console.log(`building standalone binary (${outfile})...`);

const args = [
  process.execPath, // the running bun binary
  "build",
  "--compile",
  "--minify",
  "--format=esm",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  `--asset=${nativeAsset}`,
  entry,
  "--outfile",
  outfile,
  "--define",
  `__SWEEP_VERSION__:${JSON.stringify(version)}`,
];
// Opt-out exists only to measure the same source with and without bytecode.
if (!process.argv.includes("--no-bytecode")) args.push("--bytecode");
if (target && target.startsWith("bun-")) {
  args.push("--target", target);
}

const proc = Bun.spawnSync(args, {
  cwd: REPO_ROOT,
  stdout: "inherit",
  stderr: "inherit",
});

if (proc.exitCode !== 0) {
  console.error(`✗ standalone build failed (exit ${proc.exitCode})`);
  process.exit(proc.exitCode ?? 1);
}

console.log(`✓ standalone executable ready: ${outfile}`);
