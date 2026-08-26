import { join } from "node:path";
import { REPO_ROOT, readCliVersion } from "./bundle.js";

// Standalone executables require the `--compile` flag on Bun's CLI — the
// JS API (Bun.build) emits plain JS bundles, not embedded executables.
// See https://bun.com/docs/bundler/executables

const version = readCliVersion();
const target = process.argv[2];
const outfile = process.argv[3] ?? "sweep";
const entry = join(REPO_ROOT, "apps/cli/src/bin-standalone.ts");

console.log(`building standalone binary (${outfile})...`);

const args = [
  process.execPath, // the running bun binary
  "build",
  "--compile",
  entry,
  "--outfile",
  outfile,
  "--define",
  `__SWEEP_VERSION__:${JSON.stringify(version)}`,
];
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
