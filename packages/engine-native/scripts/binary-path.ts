import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NativePlatform } from "@kitsunekode/sweep-core/native-platforms";

/** A host build must never be relabeled as a foreign-platform package. */
export function defaultBinaryPath(
  root: string,
  platform: NativePlatform,
  host = { os: process.platform as string, cpu: process.arch as string },
): string {
  const binary = `sweep-engine${platform.os === "win32" ? ".exe" : ""}`;
  const cross = join(root, "target", platform.cargoTarget, "release", binary);
  if (platform.os === host.os && platform.cpu === host.cpu) {
    const native = join(root, "target/release", binary);
    if (existsSync(native)) return native;
  }
  if (existsSync(cross)) return cross;
  throw new Error(
    `no release binary found for ${platform.id}; build --release --target ${platform.cargoTarget} or pass --binary explicitly`,
  );
}
