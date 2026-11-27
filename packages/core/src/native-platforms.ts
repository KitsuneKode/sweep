/** Turbo-style optional native engine package naming (shared with release tooling). */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export type LinuxLibc = "glibc" | "musl";

export interface NativePlatform {
  /** Directory id under `native-packages/` (e.g. `linux-64`, `linux-64-musl`). */
  id: string;
  /** Scoped npm package name. */
  npmName: string;
  os: "linux" | "darwin" | "win32";
  cpu: "x64" | "arm64";
  /** Linux C library variant; omitted on macOS and Windows. */
  libc?: LinuxLibc;
  cargoTarget: string;
  binaryName: string;
}

export const NATIVE_PLATFORMS: readonly NativePlatform[] = [
  {
    id: "linux-64",
    npmName: "@kitsunekode/sweep-engine-linux-64",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    cargoTarget: "x86_64-unknown-linux-gnu",
    binaryName: "sweep-engine",
  },
  {
    id: "linux-64-musl",
    npmName: "@kitsunekode/sweep-engine-linux-64-musl",
    os: "linux",
    cpu: "x64",
    libc: "musl",
    cargoTarget: "x86_64-unknown-linux-musl",
    binaryName: "sweep-engine",
  },
  {
    id: "linux-arm64",
    npmName: "@kitsunekode/sweep-engine-linux-arm64",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    cargoTarget: "aarch64-unknown-linux-gnu",
    binaryName: "sweep-engine",
  },
  {
    id: "linux-arm64-musl",
    npmName: "@kitsunekode/sweep-engine-linux-arm64-musl",
    os: "linux",
    cpu: "arm64",
    libc: "musl",
    cargoTarget: "aarch64-unknown-linux-musl",
    binaryName: "sweep-engine",
  },
  {
    id: "darwin-64",
    npmName: "@kitsunekode/sweep-engine-darwin-64",
    os: "darwin",
    cpu: "x64",
    cargoTarget: "x86_64-apple-darwin",
    binaryName: "sweep-engine",
  },
  {
    id: "darwin-arm64",
    npmName: "@kitsunekode/sweep-engine-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    cargoTarget: "aarch64-apple-darwin",
    binaryName: "sweep-engine",
  },
  {
    id: "windows-64",
    npmName: "@kitsunekode/sweep-engine-windows-64",
    os: "win32",
    cpu: "x64",
    cargoTarget: "x86_64-pc-windows-msvc",
    binaryName: "sweep-engine.exe",
  },
] as const;

export const NATIVE_PLATFORM_NPM_NAMES = NATIVE_PLATFORMS.map((p) => p.npmName);

export interface LinuxLibcProbe {
  glibcVersionRuntime?: string | null;
  procSelfMaps?: string | null;
  lddOutput?: string | null;
  muslLoaderExists?: boolean;
}

let cachedLinuxLibc: LinuxLibc | undefined;

function readProcessGlibcVersion(): string | null {
  try {
    const report = (
      process as { report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } } }
    ).report?.getReport?.();
    const version = report?.header?.glibcVersionRuntime;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

function readProcSelfMaps(): string | null {
  try {
    return readFileSync("/proc/self/maps", "utf8");
  } catch {
    return null;
  }
}

function readLddVersion(): string | null {
  try {
    const result = spawnSync("ldd", ["--version"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    return combined.length > 0 ? combined : null;
  } catch {
    return null;
  }
}

function hasMuslLoaderOnDisk(): boolean {
  return existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1");
}

/**
 * Determine whether the running Linux userland uses glibc or musl.
 *
 * Uses runtime report metadata and `/proc/self/maps` first so glibc hosts that
 * also happen to have musl installed still resolve as glibc, without spawning a
 * subprocess on the hot path.
 */
export function detectLinuxLibc(probe?: LinuxLibcProbe): LinuxLibc {
  if (!probe && cachedLinuxLibc) {
    return cachedLinuxLibc;
  }

  const resolved = detectLinuxLibcUncached(probe);
  if (!probe) {
    cachedLinuxLibc = resolved;
  }
  return resolved;
}

function detectLinuxLibcUncached(probe?: LinuxLibcProbe): LinuxLibc {
  const glibcVersion =
    probe && "glibcVersionRuntime" in probe ? probe.glibcVersionRuntime : readProcessGlibcVersion();
  if (typeof glibcVersion === "string" && glibcVersion.length > 0) {
    return "glibc";
  }

  const maps = probe && "procSelfMaps" in probe ? probe.procSelfMaps : readProcSelfMaps();
  if (maps) {
    if (/ld-musl-[^\s]*\.so\b/i.test(maps)) {
      return "musl";
    }
    if (/(?:ld-linux-[^\s]*\.so|libc\.so\.6)\b/i.test(maps)) {
      return "glibc";
    }
  }

  const ldd = probe && "lddOutput" in probe ? probe.lddOutput : readLddVersion();
  if (ldd) {
    if (/\bmusl\b/i.test(ldd)) {
      return "musl";
    }
    if (/\b(?:glibc|gnu libc)\b/i.test(ldd)) {
      return "glibc";
    }
  }

  const muslLoader =
    probe && "muslLoaderExists" in probe ? probe.muslLoaderExists : hasMuslLoaderOnDisk();
  return muslLoader ? "musl" : "glibc";
}

export interface HostPlatformOverride {
  platform?: string;
  arch?: string;
  libc?: LinuxLibc;
}

/** Map `process.platform` / `process.arch` (and Linux libc) to a native platform id, if supported. */
export function currentNativePlatformId(host?: HostPlatformOverride): string | null {
  const rawOs = host?.platform ?? process.platform;
  const os = rawOs === "win32" || rawOs === "darwin" || rawOs === "linux" ? rawOs : null;
  if (!os) {
    return null;
  }

  const rawCpu = host?.arch ?? process.arch;
  const cpu = rawCpu === "arm64" || rawCpu === "x64" ? rawCpu : null;
  if (!cpu) {
    return null;
  }

  const libc = os === "linux" ? (host?.libc ?? detectLinuxLibc()) : undefined;
  const match = NATIVE_PLATFORMS.find(
    (p) => p.os === os && p.cpu === cpu && (os !== "linux" || p.libc === libc),
  );
  return match?.id ?? null;
}

export function nativePlatformById(id: string): NativePlatform | undefined {
  return NATIVE_PLATFORMS.find((p) => p.id === id);
}

export function nativePlatformForCurrentProcess(
  host?: HostPlatformOverride,
): NativePlatform | undefined {
  const id = currentNativePlatformId(host);
  return id ? nativePlatformById(id) : undefined;
}
