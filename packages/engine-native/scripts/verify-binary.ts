#!/usr/bin/env bun
/**
 * Smoke-test a sweep-engine binary (usage output on empty argv).
 *
 * Usage: bun run packages/engine-native/scripts/verify-binary.ts [--binary path]
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function parseBinaryArg(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--binary" || argv[i] === "-b") {
      return argv[++i] ?? "";
    }
  }
  const release = join(REPO_ROOT, "target", "release", "sweep-engine");
  if (existsSync(release)) {
    return release;
  }
  const debug = join(REPO_ROOT, "target", "debug", "sweep-engine");
  if (existsSync(debug)) {
    return debug;
  }
  throw new Error("no binary found; pass --binary or build sweep-engine-cli");
}

const binary = resolve(parseBinaryArg(process.argv.slice(2)));
const proc = spawnSync(binary, [], { encoding: "utf8" });

if (proc.error) {
  console.error(`failed to run ${binary}: ${proc.error.message}`);
  process.exit(1);
}

if (!proc.stderr?.includes("usage:")) {
  console.error(`unexpected output from ${binary}; expected usage in stderr`);
  console.error(proc.stderr);
  process.exit(1);
}

console.log(`ok: ${binary}`);
