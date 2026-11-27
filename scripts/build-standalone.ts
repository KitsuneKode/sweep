import { join, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { REPO_ROOT, readCliVersion } from "./bundle.js";

// Standalone executables require the `--compile` flag on Bun's CLI - the
// JS API (Bun.build) emits plain JS bundles, not embedded executables.
// See https://bun.com/docs/bundler/executables

function parseArgs(argv: string[]): {
  target: string;
  outfile: string;
  enginePath?: string;
  noBytecode: boolean;
} {
  const positional: string[] = [];
  let enginePath: string | undefined;
  let noBytecode = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--engine" || arg === "-e") {
      enginePath = argv[++i];
      if (!enginePath) throw new Error("--engine requires a binary path");
    } else if (arg === "--no-bytecode") {
      noBytecode = true;
    } else if (arg.startsWith("--engine=")) {
      enginePath = arg.slice("--engine=".length);
    } else {
      positional.push(arg);
    }
  }

  return {
    target: positional[0] ?? "",
    outfile: positional[1] ?? "sweep",
    ...(enginePath !== undefined ? { enginePath } : {}),
    noBytecode,
  };
}

const version = readCliVersion();
const { target, outfile, enginePath, noBytecode } = parseArgs(process.argv.slice(2));
const entry = join(REPO_ROOT, "apps/cli/src/bin-standalone.ts");

const hostOs = process.platform === "win32" ? "windows" : process.platform;
const hostPrefix = `bun-${hostOs}-${process.arch}`;
const isLinuxMusl = process.platform === "linux" && target === `${hostPrefix}-musl`;

if (target && target !== hostPrefix && !isLinuxMusl) {
  throw new Error("Standalone builds must run on the target platform to embed its native engine");
}

const defaultNativeAsset = isLinuxMusl
  ? `target/${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl/release/sweep-engine`
  : `target/release/sweep-engine${process.platform === "win32" ? ".exe" : ""}`;

const resolvedNative = resolve(REPO_ROOT, enginePath ?? defaultNativeAsset);
if (!existsSync(resolvedNative)) {
  throw new Error(
    `Native Rust engine not found at ${resolvedNative}; build it first (or pass --engine <path>)`,
  );
}
const nativeAsset = relative(REPO_ROOT, resolvedNative);

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
if (isLinuxMusl) {
  args.push("--define", `process.env.OPENTUI_LIBC:${JSON.stringify("musl")}`);
}
// Opt-out exists only to measure the same source with and without bytecode.
if (!noBytecode) args.push("--bytecode");
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
