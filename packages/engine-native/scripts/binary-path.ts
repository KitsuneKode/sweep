import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  detectLinuxLibc,
  type DetectedLinuxLibc,
  type NativePlatform,
} from "@kitsunekode/sweep-core/native-platforms";

export interface BinaryPathHost {
  os: string;
  cpu: string;
  libc?: DetectedLinuxLibc;
}

/** A host build must never be relabeled as a foreign-platform or foreign-libc package. */
export function defaultBinaryPath(
  root: string,
  platform: NativePlatform,
  host: BinaryPathHost = {
    os: process.platform as string,
    cpu: process.arch as string,
    ...(process.platform === "linux" ? { libc: detectLinuxLibc() } : {}),
  },
): string {
  const binary = `sweep-engine${platform.os === "win32" ? ".exe" : ""}`;
  const cross = join(root, "target", platform.cargoTarget, "release", binary);
  const sameLibc =
    platform.os !== "linux" ||
    (host.libc !== "unknown" && platform.libc === (host.libc ?? "glibc"));
  if (platform.os === host.os && platform.cpu === host.cpu && sameLibc) {
    const native = join(root, "target/release", binary);
    if (existsSync(native)) return native;
  }
  if (existsSync(cross)) return cross;
  throw new Error(
    `no release binary found for ${platform.id}; build --release --target ${platform.cargoTarget} or pass --binary explicitly`,
  );
}
