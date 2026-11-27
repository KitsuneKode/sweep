/** Turbo-style optional native engine package naming (shared with release tooling). */

import { closeSync, openSync, readFileSync, readSync } from "node:fs";

export type LinuxLibc = "glibc" | "musl";
export type DetectedLinuxLibc = LinuxLibc | "unknown";

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
  /** ELF PT_INTERP of the running executable (`process.execPath`). */
  elfInterpreter?: string | null;
  /** Contents of `/proc/self/maps`. */
  procSelfMaps?: string | null;
  /** `process.report.getReport().header.glibcVersionRuntime`. */
  glibcVersionRuntime?: string | null;
}

const PT_INTERP = 3;
const ELF_HEADER_SCAN_BYTES = 64 * 1024;
const MAX_INTERP_BYTES = 4096;

let cachedLinuxLibc: DetectedLinuxLibc | undefined;

function readUint16(buf: Uint8Array, offset: number, littleEndian: boolean): number {
  return littleEndian
    ? buf[offset]! | (buf[offset + 1]! << 8)
    : (buf[offset]! << 8) | buf[offset + 1]!;
}

function readUint32(buf: Uint8Array, offset: number, littleEndian: boolean): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getUint32(offset, littleEndian);
}

function readUint64AsNumber(buf: Uint8Array, offset: number, littleEndian: boolean): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const value = view.getBigUint64(offset, littleEndian);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return -1;
  return Number(value);
}

function decodeCString(buf: Uint8Array, start: number, length: number): string | null {
  if (start < 0 || length <= 0 || start + length > buf.length) return null;
  let end = start + length;
  for (let i = start; i < end; i++) {
    if (buf[i] === 0) {
      end = i;
      break;
    }
  }
  const value = Buffer.from(buf.subarray(start, end)).toString("utf8").trim();
  return value.length > 0 ? value : null;
}

interface ElfInterpLocation {
  offset: number;
  size: number;
}

function locateElfInterpreter(buf: Uint8Array): ElfInterpLocation | null {
  if (buf.length < 52) return null;
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    return null;
  }
  const eiClass = buf[4];
  const eiData = buf[5];
  if ((eiClass !== 1 && eiClass !== 2) || (eiData !== 1 && eiData !== 2)) {
    return null;
  }
  const littleEndian = eiData === 1;
  const is64 = eiClass === 2;
  if (is64 && buf.length < 64) return null;

  const phoff = is64
    ? readUint64AsNumber(buf, 32, littleEndian)
    : readUint32(buf, 28, littleEndian);
  const phentsize = readUint16(buf, is64 ? 54 : 42, littleEndian);
  const phnum = readUint16(buf, is64 ? 56 : 44, littleEndian);

  if (phoff < 0 || phentsize < (is64 ? 56 : 32) || phnum === 0 || phnum > 1024) {
    return null;
  }

  for (let i = 0; i < phnum; i++) {
    const entryOffset = phoff + i * phentsize;
    if (entryOffset + phentsize > buf.length) break;
    const pType = readUint32(buf, entryOffset, littleEndian);
    if (pType !== PT_INTERP) continue;
    const pOffset = is64
      ? readUint64AsNumber(buf, entryOffset + 8, littleEndian)
      : readUint32(buf, entryOffset + 4, littleEndian);
    const pFilesz = is64
      ? readUint64AsNumber(buf, entryOffset + 32, littleEndian)
      : readUint32(buf, entryOffset + 16, littleEndian);
    if (pOffset < 0 || pFilesz <= 0 || pFilesz > MAX_INTERP_BYTES) {
      return null;
    }
    return { offset: pOffset, size: pFilesz };
  }
  return null;
}

/** Parse the `PT_INTERP` dynamic linker path from an in-memory ELF image. */
export function parseElfInterpreter(bytes: Uint8Array): string | null {
  const loc = locateElfInterpreter(bytes);
  if (!loc) return null;
  return decodeCString(bytes, loc.offset, loc.size);
}

/** Read `PT_INTERP` directly from an executable ELF file without spawning subprocesses. */
export function readElfInterpreter(execPath: string = process.execPath): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(execPath, "r");
    const headerBuf = Buffer.allocUnsafe(ELF_HEADER_SCAN_BYTES);
    const bytesRead = readSync(fd, headerBuf, 0, ELF_HEADER_SCAN_BYTES, 0);
    const head = headerBuf.subarray(0, bytesRead);
    const loc = locateElfInterpreter(head);
    if (!loc) return null;
    if (loc.offset + loc.size <= head.length) {
      return decodeCString(head, loc.offset, loc.size);
    }
    const interpBuf = Buffer.allocUnsafe(loc.size);
    const interpRead = readSync(fd, interpBuf, 0, loc.size, loc.offset);
    return decodeCString(interpBuf.subarray(0, interpRead), 0, interpRead);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
}

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

/**
 * Determine whether the running Linux executable uses glibc, musl, or an
 * inconclusive (`"unknown"`) C library.
 *
 * Prefers the running executable's own ELF `PT_INTERP` and mapped libraries in
 * `/proc/self/maps` so mixed-libc environments (such as Alpine with `gcompat`
 * or a glibc host with musl libraries installed) resolve to the actual runtime
 * libc. Never invokes `ldd` from ambient `PATH`, and returns `"unknown"` rather
 * than guessing when evidence is missing or contradictory.
 */
export function detectLinuxLibc(probe?: LinuxLibcProbe): DetectedLinuxLibc {
  if (!probe && cachedLinuxLibc) {
    return cachedLinuxLibc;
  }

  const resolved = detectLinuxLibcUncached(probe);
  if (!probe) {
    cachedLinuxLibc = resolved;
  }
  return resolved;
}

function detectLinuxLibcUncached(probe?: LinuxLibcProbe): DetectedLinuxLibc {
  const interp = probe && "elfInterpreter" in probe ? probe.elfInterpreter : readElfInterpreter();
  if (typeof interp === "string" && interp.length > 0) {
    if (/ld-musl/i.test(interp)) {
      return "musl";
    }
    if (/ld-linux/i.test(interp)) {
      return "glibc";
    }
  }

  const maps = probe && "procSelfMaps" in probe ? probe.procSelfMaps : readProcSelfMaps();
  if (maps) {
    const hasMusl = /ld-musl-[^\s]*\.so\b/i.test(maps);
    const hasGlibc = /(?:ld-linux-[^\s]*\.so|libc\.so\.6)\b/i.test(maps);
    if (hasMusl && !hasGlibc) {
      return "musl";
    }
    if (hasGlibc && !hasMusl) {
      return "glibc";
    }
    if (hasMusl && hasGlibc) {
      // Both loaders/runtimes mapped with no authoritative PT_INTERP: inconclusive.
      return "unknown";
    }
  }

  const glibcVersion =
    probe && "glibcVersionRuntime" in probe ? probe.glibcVersionRuntime : readProcessGlibcVersion();
  if (typeof glibcVersion === "string" && glibcVersion.length > 0) {
    return "glibc";
  }

  return "unknown";
}

export interface HostPlatformOverride {
  platform?: string;
  arch?: string;
  libc?: DetectedLinuxLibc;
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
  if (os === "linux" && libc === "unknown") {
    return null;
  }
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
