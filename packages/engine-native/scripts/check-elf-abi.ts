#!/usr/bin/env bun
/**
 * Verify ELF dynamic linker and GLIBC symbol version floor for Linux binaries.
 *
 * Usage:
 *   bun run packages/engine-native/scripts/check-elf-abi.ts --binary path --mode glibc --max-glibc 2.17
 *   bun run packages/engine-native/scripts/check-elf-abi.ts --binary path --mode musl-static
 *   bun run packages/engine-native/scripts/check-elf-abi.ts --binary path --mode musl-dynamic
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type ElfAbiMode = "glibc" | "musl-static" | "musl-dynamic";

export interface ElfAbiCheckInput {
  mode: ElfAbiMode;
  maxGlibc?: string;
  glibcVersions: readonly string[];
  hasGlibcPrivate: boolean;
  interpreter: string | null;
}

export interface ElfAbiCheckResult {
  ok: boolean;
  maxFound: string | null;
  interpreter: string | null;
  error?: string;
}

/** Compare dotted numeric versions like `2.2.5`, `2.17`, `2.39`. */
export function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** Parse required GLIBC_* version names from `readelf -V --wide` output. */
export function parseReadelfVersions(output: string): {
  glibcVersions: string[];
  hasGlibcPrivate: boolean;
} {
  const versions = new Set<string>();
  let hasGlibcPrivate = false;
  let inVerneed = false;

  for (const line of output.split(/\r?\n/)) {
    if (/^Version needs section\b/i.test(line)) {
      inVerneed = true;
      continue;
    }
    if (inVerneed && /^(?:Version (?:symbols|definition) section\b|\S)/i.test(line)) {
      if (!/^\s/.test(line)) {
        inVerneed = false;
      }
    }
    if (!inVerneed) continue;

    if (/\bName:\s+GLIBC_PRIVATE\b/.test(line)) {
      hasGlibcPrivate = true;
    }
    const match = /\bName:\s+GLIBC_(\d+(?:\.\d+)*)\b/.exec(line);
    if (match?.[1]) {
      versions.add(match[1]);
    }
  }

  return {
    glibcVersions: [...versions].sort(compareVersion),
    hasGlibcPrivate,
  };
}

/** Parse PT_INTERP from `readelf -l --wide` output. */
export function parseReadelfInterpreter(output: string): string | null {
  const match = /\[Requesting program interpreter:\s*([^\]]+)\]/.exec(output);
  return match?.[1]?.trim() ?? null;
}

export function evaluateElfAbi(input: ElfAbiCheckInput): ElfAbiCheckResult {
  const sorted = [...input.glibcVersions].sort(compareVersion);
  const maxFound = sorted.length > 0 ? (sorted[sorted.length - 1] ?? null) : null;

  if (input.hasGlibcPrivate) {
    return {
      ok: false,
      maxFound,
      interpreter: input.interpreter,
      error: "ELF requires GLIBC_PRIVATE symbols",
    };
  }

  if (input.mode === "glibc") {
    const floor = input.maxGlibc ?? "2.17";
    if (input.interpreter && /ld-musl/i.test(input.interpreter)) {
      return {
        ok: false,
        maxFound,
        interpreter: input.interpreter,
        error: `Expected a glibc binary, but interpreter is ${input.interpreter}`,
      };
    }
    if (maxFound && compareVersion(maxFound, floor) > 0) {
      const offenders = sorted.filter((v) => compareVersion(v, floor) > 0);
      return {
        ok: false,
        maxFound,
        interpreter: input.interpreter,
        error: `ELF requires GLIBC_${maxFound} (exceeds floor GLIBC_${floor}; offending: ${offenders.map((v) => `GLIBC_${v}`).join(", ")})`,
      };
    }
    return { ok: true, maxFound, interpreter: input.interpreter };
  }

  if (sorted.length > 0) {
    return {
      ok: false,
      maxFound,
      interpreter: input.interpreter,
      error: `Expected a musl binary with zero GLIBC symbol requirements, found ${sorted.map((v) => `GLIBC_${v}`).join(", ")}`,
    };
  }

  if (input.mode === "musl-static") {
    if (input.interpreter !== null) {
      return {
        ok: false,
        maxFound,
        interpreter: input.interpreter,
        error: `Expected a statically linked musl binary without PT_INTERP, found interpreter ${input.interpreter}`,
      };
    }
    return { ok: true, maxFound: null, interpreter: null };
  }

  // musl-dynamic (e.g. Bun --compile --target=bun-linux-*-musl)
  if (!input.interpreter || !/ld-musl/i.test(input.interpreter)) {
    return {
      ok: false,
      maxFound,
      interpreter: input.interpreter,
      error: `Expected a musl dynamic interpreter (ld-musl), found ${input.interpreter ?? "none"}`,
    };
  }
  return { ok: true, maxFound: null, interpreter: input.interpreter };
}

function parseArgs(argv: string[]): { binary: string; mode: ElfAbiMode; maxGlibc: string } {
  let binary = "";
  let mode: ElfAbiMode = "glibc";
  let maxGlibc = "2.17";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--binary" || arg === "-b") {
      binary = argv[++i] ?? "";
    } else if (arg === "--mode" || arg === "-m") {
      const value = argv[++i] ?? "";
      if (value !== "glibc" && value !== "musl-static" && value !== "musl-dynamic") {
        throw new Error(
          `unsupported --mode "${value}" (expected glibc, musl-static, musl-dynamic)`,
        );
      }
      mode = value;
    } else if (arg === "--max-glibc") {
      maxGlibc = argv[++i] ?? "";
      if (!/^\d+(?:\.\d+)*$/.test(maxGlibc)) {
        throw new Error(`invalid --max-glibc version "${maxGlibc}"`);
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: check-elf-abi.ts --binary <path> --mode <glibc|musl-static|musl-dynamic> [--max-glibc 2.17]",
      );
      process.exit(0);
    }
  }

  if (!binary) {
    throw new Error("--binary is required");
  }

  return { binary, mode, maxGlibc };
}

function runReadelf(args: string[]): string {
  const proc = spawnSync("readelf", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (proc.error) {
    throw new Error(`readelf failed to start: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new Error(`readelf ${args.join(" ")} failed (${proc.status}): ${proc.stderr}`);
  }
  return proc.stdout;
}

if (import.meta.main) {
  const { binary: binaryArg, mode, maxGlibc } = parseArgs(process.argv.slice(2));
  const binary = resolve(binaryArg);
  if (!existsSync(binary)) {
    console.error(`error: binary not found: ${binary}`);
    process.exit(1);
  }

  const versionOutput = runReadelf(["-V", "--wide", binary]);
  const programHeaders = runReadelf(["-l", "--wide", binary]);
  const { glibcVersions, hasGlibcPrivate } = parseReadelfVersions(versionOutput);
  const interpreter = parseReadelfInterpreter(programHeaders);
  const result = evaluateElfAbi({
    mode,
    maxGlibc,
    glibcVersions,
    hasGlibcPrivate,
    interpreter,
  });

  if (!result.ok) {
    console.error(`error: ${binary}: ${result.error}`);
    process.exit(1);
  }

  console.log(
    `ok: ${binary} (mode=${mode}, max_glibc=${result.maxFound ?? "none"}, interpreter=${result.interpreter ?? "static"})`,
  );
}
