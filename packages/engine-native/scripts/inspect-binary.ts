#!/usr/bin/env bun
/**
 * Validate a packed native binary without executing it (for cross-compiled targets).
 *
 * Usage:
 *   bun run packages/engine-native/scripts/inspect-binary.ts --binary path --expect aarch64
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ARCH_PATTERNS: Record<string, RegExp[]> = {
  x86_64: [/x86[-_]?64/i, /\b64-bit.*x86/i, /\bIntel 80386\b/i],
  aarch64: [/aarch64/i, /\bARM64\b/i],
};

function parseArgs(argv: string[]): { binary: string; expect: string } {
  let binary = "";
  let expect = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--binary" || arg === "-b") {
      binary = argv[++i] ?? "";
    } else if (arg === "--expect" || arg === "-e") {
      expect = argv[++i] ?? "";
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: inspect-binary.ts --binary <path> --expect <x86_64|aarch64>");
      process.exit(0);
    }
  }

  if (!binary || !expect) {
    console.error("error: --binary and --expect are required");
    process.exit(1);
  }

  if (!ARCH_PATTERNS[expect]) {
    console.error(`error: unsupported --expect architecture "${expect}"`);
    process.exit(1);
  }

  return { binary, expect };
}

const { binary: binaryArg, expect } = parseArgs(process.argv.slice(2));
const binary = resolve(binaryArg);

if (!existsSync(binary)) {
  console.error(`error: binary not found: ${binary}`);
  process.exit(1);
}

const size = statSync(binary).size;
if (size === 0) {
  console.error(`error: binary is empty: ${binary}`);
  process.exit(1);
}

const file = spawnSync("file", ["-b", binary], { encoding: "utf8" });
if (file.status !== 0) {
  console.error(`error: file(1) failed for ${binary}`);
  console.error(file.stderr);
  process.exit(1);
}

const description = file.stdout.trim();
const patterns = ARCH_PATTERNS[expect] ?? [];
if (!patterns.some((pattern) => pattern.test(description))) {
  console.error(`error: expected ${expect} binary, got: ${description}`);
  process.exit(1);
}

console.log(`ok: ${binary} (${description})`);
