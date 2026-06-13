/** Turbo-style optional native engine package naming (shared with release tooling). */

export interface NativePlatform {
  /** Directory id under `native-packages/` (e.g. `linux-64`). */
  id: string;
  /** Scoped npm package name. */
  npmName: string;
  os: "linux" | "darwin" | "win32";
  cpu: "x64" | "arm64";
  cargoTarget: string;
  binaryName: string;
}

export const NATIVE_PLATFORMS: readonly NativePlatform[] = [
  {
    id: "linux-64",
    npmName: "@kitsunekode/sweep-engine-linux-64",
    os: "linux",
    cpu: "x64",
    cargoTarget: "x86_64-unknown-linux-gnu",
    binaryName: "sweep-engine",
  },
  {
    id: "linux-arm64",
    npmName: "@kitsunekode/sweep-engine-linux-arm64",
    os: "linux",
    cpu: "arm64",
    cargoTarget: "aarch64-unknown-linux-gnu",
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

/** Map `process.platform` / `process.arch` to a native platform id, if supported. */
export function currentNativePlatformId(): string | null {
  const os =
    process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const cpu = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!cpu) {
    return null;
  }

  const match = NATIVE_PLATFORMS.find((p) => p.os === os && p.cpu === cpu);
  return match?.id ?? null;
}

export function nativePlatformById(id: string): NativePlatform | undefined {
  return NATIVE_PLATFORMS.find((p) => p.id === id);
}

export function nativePlatformForCurrentProcess(): NativePlatform | undefined {
  const id = currentNativePlatformId();
  return id ? nativePlatformById(id) : undefined;
}
