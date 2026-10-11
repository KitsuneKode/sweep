import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { NativePlatform } from "@kitsunekode/sweep-core/native-platforms";

/** Validate platform headers without executing a foreign or arbitrary binary. */
export function assertBinaryFormat(
  header: Buffer,
  fileBytes: number,
  platform: NativePlatform,
): void {
  const refuse = () => {
    throw new Error(
      `Expected a ${platform.id} executable; provide a complete binary built for ${platform.cargoTarget}`,
    );
  };
  if (header.length < 64 || fileBytes < 64) refuse();
  if (platform.os === "linux") {
    if (
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      header[6] !== 1
    )
      refuse();
    const machine = header.readUInt16LE(18);
    if (machine !== (platform.cpu === "x64" ? 62 : 183)) refuse();
    const kind = header.readUInt16LE(16);
    if (kind !== 2 && kind !== 3) refuse();
  } else if (platform.os === "darwin") {
    // Platform npm packages carry one architecture each, not universal binaries.
    if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(12) !== 2) refuse();
    if (header.readUInt32LE(4) !== (platform.cpu === "x64" ? 0x01000007 : 0x0100000c)) refuse();
  } else {
    if (header.readUInt16LE(0) !== 0x5a4d) refuse();
    const offset = header.readUInt32LE(60);
    if (offset < 64 || offset + 26 > header.length || offset + 26 > fileBytes) refuse();
    if (
      header.readUInt32LE(offset) !== 0x00004550 ||
      header.readUInt16LE(offset + 4) !== 0x8664 ||
      header.readUInt16LE(offset + 24) !== 0x20b
    )
      refuse();
    const characteristics = header.readUInt16LE(offset + 22);
    if (!(characteristics & 2) || characteristics & 0x2000) refuse();
  }
}

export function assertNativeBinary(path: string, platform: NativePlatform): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new Error(`Native payload must be a regular executable file for ${platform.id}`);
    const header = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    let read = 0;
    while (read < header.length) {
      const next = readSync(fd, header, read, header.length - read, read);
      if (!next) break;
      read += next;
    }
    assertBinaryFormat(header.subarray(0, read), stat.size, platform);
  } finally {
    closeSync(fd);
  }
}
