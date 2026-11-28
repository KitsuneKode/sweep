#!/usr/bin/env bun
/**
 * Verify ELF dynamic linker, DT_NEEDED, and GLIBC symbol version floor for
 * Linux binaries and embedded OpenTUI shared objects.
 *
 * Usage:
 *   bun run packages/engine-native/scripts/check-elf-abi.ts --binary path --mode glibc --max-glibc 2.17
 *   bun run packages/engine-native/scripts/check-elf-abi.ts --binary path --mode musl-static
 *   bun run packages/engine-native/scripts/check-elf-abi.ts --binary path --mode musl-dynamic \
 *     --metafile build.meta.json --embedded-so-mode musl-so --embedded-engine ./sweep-engine:musl-static
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ElfAbiMode = "glibc" | "glibc-so" | "musl-static" | "musl-dynamic" | "musl-so";

export interface ElfAbiCheckInput {
  mode: ElfAbiMode;
  maxGlibc?: string;
  glibcVersions: readonly string[];
  /** Non-numeric GLIBC_* version needs such as GLIBC_PRIVATE or GLIBC_ABI_DT_RELR. */
  disallowedGlibcVersions?: readonly string[];
  hasGlibcPrivate?: boolean;
  interpreter: string | null;
  neededLibraries?: readonly string[];
}

export interface ElfAbiCheckResult {
  ok: boolean;
  maxFound: string | null;
  interpreter: string | null;
  neededLibraries: string[];
  disallowedGlibcVersions: string[];
  error?: string;
}

const NUMERIC_GLIBC_RE = /^GLIBC_(\d+(?:\.\d+)*)$/;

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

/**
 * Parse every required `GLIBC_*` version name (numeric, `GLIBC_PRIVATE`,
 * `GLIBC_ABI_*`, etc.) from `readelf -V --wide` output.
 */
export function parseReadelfVersions(output: string): {
  glibcVersions: string[];
  disallowedGlibcVersions: string[];
  hasGlibcPrivate: boolean;
} {
  const numeric = new Set<string>();
  const disallowed = new Set<string>();
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

    const match = /\bName:\s+(\S+)/.exec(line);
    const name = match?.[1];
    if (!name || !/^GLIBC_/i.test(name)) continue;

    const numMatch = NUMERIC_GLIBC_RE.exec(name);
    if (numMatch?.[1]) {
      numeric.add(numMatch[1]);
    } else {
      disallowed.add(name);
    }
  }

  const disallowedList = [...disallowed].sort();
  return {
    glibcVersions: [...numeric].sort(compareVersion),
    disallowedGlibcVersions: disallowedList,
    hasGlibcPrivate: disallowed.has("GLIBC_PRIVATE"),
  };
}

/** Parse PT_INTERP from `readelf -l --wide` output. */
export function parseReadelfInterpreter(output: string): string | null {
  const match = /\[Requesting program interpreter:\s*([^\]]+)\]/.exec(output);
  return match?.[1]?.trim() ?? null;
}

/** Parse DT_NEEDED shared library names from `readelf -d --wide` output. */
export function parseReadelfNeeded(output: string): string[] {
  const needed: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /\(NEEDED\)\s+Shared library:\s+\[([^\]]+)\]/.exec(line);
    if (match?.[1]) {
      needed.push(match[1].trim());
    }
  }
  return needed;
}

export function evaluateElfAbi(input: ElfAbiCheckInput): ElfAbiCheckResult {
  const sorted = [...input.glibcVersions].sort(compareVersion);
  const maxFound = sorted.length > 0 ? (sorted[sorted.length - 1] ?? null) : null;
  const neededLibraries = [...(input.neededLibraries ?? [])];
  const disallowedSet = new Set(input.disallowedGlibcVersions ?? []);
  if (input.hasGlibcPrivate) {
    disallowedSet.add("GLIBC_PRIVATE");
  }
  const disallowedGlibcVersions = [...disallowedSet].sort();

  if (disallowedGlibcVersions.length > 0) {
    return {
      ok: false,
      maxFound,
      interpreter: input.interpreter,
      neededLibraries,
      disallowedGlibcVersions,
      error: `ELF requires disallowed GLIBC version tag(s): ${disallowedGlibcVersions.join(", ")}`,
    };
  }

  if (input.mode === "glibc" || input.mode === "glibc-so") {
    const floor = input.maxGlibc ?? "2.17";
    if (input.interpreter && /ld-musl/i.test(input.interpreter)) {
      return {
        ok: false,
        maxFound,
        interpreter: input.interpreter,
        neededLibraries,
        disallowedGlibcVersions,
        error: `Expected a glibc binary, but interpreter is ${input.interpreter}`,
      };
    }
    if (maxFound && compareVersion(maxFound, floor) > 0) {
      const offenders = sorted.filter((v) => compareVersion(v, floor) > 0);
      return {
        ok: false,
        maxFound,
        interpreter: input.interpreter,
        neededLibraries,
        disallowedGlibcVersions,
        error: `ELF requires GLIBC_${maxFound} (exceeds floor GLIBC_${floor}; offending: ${offenders.map((v) => `GLIBC_${v}`).join(", ")})`,
      };
    }
    return {
      ok: true,
      maxFound,
      interpreter: input.interpreter,
      neededLibraries,
      disallowedGlibcVersions,
    };
  }

  if (sorted.length > 0) {
    return {
      ok: false,
      maxFound,
      interpreter: input.interpreter,
      neededLibraries,
      disallowedGlibcVersions,
      error: `Expected a musl binary with zero GLIBC symbol requirements, found ${sorted.map((v) => `GLIBC_${v}`).join(", ")}`,
    };
  }

  if (input.mode === "musl-static") {
    if (input.interpreter !== null) {
      return {
        ok: false,
        maxFound,
        interpreter: input.interpreter,
        neededLibraries,
        disallowedGlibcVersions,
        error: `Expected a statically linked musl binary without PT_INTERP, found interpreter ${input.interpreter}`,
      };
    }
    if (neededLibraries.length > 0) {
      return {
        ok: false,
        maxFound,
        interpreter: null,
        neededLibraries,
        disallowedGlibcVersions,
        error: `Expected a statically linked musl binary with no DT_NEEDED entries, found: ${neededLibraries.join(", ")}`,
      };
    }
    return {
      ok: true,
      maxFound: null,
      interpreter: null,
      neededLibraries,
      disallowedGlibcVersions,
    };
  }

  const glibcNeeded = neededLibraries.filter((lib) => /^(?:libc\.so\.6|ld-linux)/i.test(lib));
  if (glibcNeeded.length > 0) {
    return {
      ok: false,
      maxFound,
      interpreter: input.interpreter,
      neededLibraries,
      disallowedGlibcVersions,
      error: `Expected a musl binary without glibc DT_NEEDED entries, found: ${glibcNeeded.join(", ")}`,
    };
  }

  if (input.mode === "musl-so") {
    if (input.interpreter && /ld-linux/i.test(input.interpreter)) {
      return {
        ok: false,
        maxFound,
        interpreter: input.interpreter,
        neededLibraries,
        disallowedGlibcVersions,
        error: `Expected a musl shared object, but interpreter is ${input.interpreter}`,
      };
    }
    return {
      ok: true,
      maxFound: null,
      interpreter: input.interpreter,
      neededLibraries,
      disallowedGlibcVersions,
    };
  }

  // musl-dynamic (e.g. Bun --compile --target=bun-linux-*-musl)
  if (!input.interpreter || !/ld-musl/i.test(input.interpreter)) {
    return {
      ok: false,
      maxFound,
      interpreter: input.interpreter,
      neededLibraries,
      disallowedGlibcVersions,
      error: `Expected a musl dynamic interpreter (ld-musl), found ${input.interpreter ?? "none"}`,
    };
  }
  return {
    ok: true,
    maxFound: null,
    interpreter: input.interpreter,
    neededLibraries,
    disallowedGlibcVersions,
  };
}

/** Extract `.so` input paths from a Bun build `--metafile` JSON document. */
export function extractSharedObjectsFromMetafile(metafileJson: string): string[] {
  const parsed = JSON.parse(metafileJson) as { inputs?: Record<string, unknown> };
  const inputs = parsed.inputs ?? {};
  return Object.keys(inputs)
    .filter((key) => /\.so(?:\.\d+)*$/.test(key))
    .sort();
}

function parseMode(value: string, flagName: string): ElfAbiMode {
  if (
    value !== "glibc" &&
    value !== "glibc-so" &&
    value !== "musl-static" &&
    value !== "musl-dynamic" &&
    value !== "musl-so"
  ) {
    throw new Error(
      `unsupported ${flagName} "${value}" (expected glibc, glibc-so, musl-static, musl-dynamic, musl-so)`,
    );
  }
  return value;
}

interface ParsedCliArgs {
  binary: string;
  mode: ElfAbiMode;
  maxGlibc: string;
  metafile?: string | undefined;
  embeddedSoMode?: ElfAbiMode | undefined;
  embeddedChecks: Array<{ path: string; mode: ElfAbiMode }>;
}

function parseArgs(argv: string[]): ParsedCliArgs {
  let binary = "";
  let mode: ElfAbiMode = "glibc";
  let maxGlibc = "2.17";
  let metafile: string | undefined;
  let embeddedSoMode: ElfAbiMode | undefined;
  const embeddedChecks: Array<{ path: string; mode: ElfAbiMode }> = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--binary" || arg === "-b") {
      binary = argv[++i] ?? "";
    } else if (arg === "--mode" || arg === "-m") {
      mode = parseMode(argv[++i] ?? "", "--mode");
    } else if (arg === "--max-glibc") {
      maxGlibc = argv[++i] ?? "";
      if (!/^\d+(?:\.\d+)*$/.test(maxGlibc)) {
        throw new Error(`invalid --max-glibc version "${maxGlibc}"`);
      }
    } else if (arg === "--metafile") {
      metafile = argv[++i] ?? "";
    } else if (arg === "--embedded-so-mode") {
      embeddedSoMode = parseMode(argv[++i] ?? "", "--embedded-so-mode");
    } else if (arg === "--verify-embedded") {
      const spec = argv[++i] ?? "";
      const sep = spec.lastIndexOf(":");
      if (sep <= 0 || sep === spec.length - 1) {
        throw new Error(`invalid --verify-embedded "${spec}" (expected <path>:<mode>)`);
      }
      embeddedChecks.push({
        path: spec.slice(0, sep),
        mode: parseMode(spec.slice(sep + 1), "--verify-embedded"),
      });
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: check-elf-abi.ts --binary <path> --mode <glibc|glibc-so|musl-static|musl-dynamic|musl-so> [--max-glibc 2.17] [--metafile <meta.json> --embedded-so-mode <glibc-so|musl-so>] [--verify-embedded <path>:<mode>]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!binary) {
    throw new Error("--binary is required");
  }

  return { binary, mode, maxGlibc, metafile, embeddedSoMode, embeddedChecks };
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

function inspectElfFile(binaryPath: string, mode: ElfAbiMode, maxGlibc: string): ElfAbiCheckResult {
  const versionOutput = runReadelf(["-V", "--wide", binaryPath]);
  const programHeaders = runReadelf(["-l", "--wide", binaryPath]);
  const dynamicOutput = runReadelf(["-d", "--wide", binaryPath]);
  const { glibcVersions, disallowedGlibcVersions, hasGlibcPrivate } =
    parseReadelfVersions(versionOutput);
  const interpreter = parseReadelfInterpreter(programHeaders);
  const neededLibraries = parseReadelfNeeded(dynamicOutput);
  return evaluateElfAbi({
    mode,
    maxGlibc,
    glibcVersions,
    disallowedGlibcVersions,
    hasGlibcPrivate,
    interpreter,
    neededLibraries,
  });
}

if (import.meta.main) {
  const {
    binary: binaryArg,
    mode,
    maxGlibc,
    metafile,
    embeddedSoMode,
    embeddedChecks,
  } = parseArgs(process.argv.slice(2));
  const binary = resolve(binaryArg);
  if (!existsSync(binary)) {
    console.error(`error: binary not found: ${binary}`);
    process.exit(1);
  }

  const result = inspectElfFile(binary, mode, maxGlibc);
  if (!result.ok) {
    console.error(`error: ${binary}: ${result.error}`);
    process.exit(1);
  }

  console.log(
    `ok: ${binary} (mode=${mode}, max_glibc=${result.maxFound ?? "none"}, interpreter=${result.interpreter ?? "static"}, needed=${result.neededLibraries.length})`,
  );

  const allEmbedded = [...embeddedChecks];
  if (metafile) {
    const metaPath = resolve(metafile);
    if (!existsSync(metaPath)) {
      console.error(`error: metafile not found: ${metaPath}`);
      process.exit(1);
    }
    const soPaths = extractSharedObjectsFromMetafile(readFileSync(metaPath, "utf8"));
    if (soPaths.length === 0) {
      console.error(
        `error: metafile ${metaPath} lists no embedded .so files (expected libopentui.so)`,
      );
      process.exit(1);
    }
    const soMode = embeddedSoMode ?? (mode === "glibc" ? "glibc-so" : "musl-so");
    for (const soPath of soPaths) {
      allEmbedded.push({ path: soPath, mode: soMode });
    }
  }

  if (allEmbedded.length > 0) {
    const containerBytes = readFileSync(binary);
    for (const item of allEmbedded) {
      const assetPath = resolve(item.path);
      if (!existsSync(assetPath)) {
        console.error(`error: embedded asset not found: ${assetPath}`);
        process.exit(1);
      }
      const assetBytes = readFileSync(assetPath);
      if (assetBytes.length === 0 || containerBytes.indexOf(assetBytes) < 0) {
        console.error(
          `error: ${assetPath} (${assetBytes.length} bytes) was not found embedded verbatim inside ${binary}`,
        );
        process.exit(1);
      }
      const assetResult = inspectElfFile(assetPath, item.mode, maxGlibc);
      if (!assetResult.ok) {
        console.error(`error: embedded ${assetPath}: ${assetResult.error}`);
        process.exit(1);
      }
      console.log(
        `ok: embedded ${assetPath} (mode=${item.mode}, max_glibc=${assetResult.maxFound ?? "none"}, needed=${assetResult.neededLibraries.length})`,
      );
    }
  }
}
