import { lstatSync, type BigIntStats } from "node:fs";
import type { FilesystemIdentity } from "@kitsunekode/sweep-protocol";

export function validFilesystemIdentity(value: unknown): value is FilesystemIdentity {
  if (typeof value !== "object" || value === null) return false;
  const id = value as Record<string, unknown>;
  const decimal = (v: unknown) =>
    typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
  return (
    (id.platform === "unix" || id.platform === "windows") &&
    decimal(id.device) &&
    decimal(id.inode) &&
    id.inode !== "0" &&
    Object.keys(id).length === 3
  );
}

export function identityFromStat(stat: BigIntStats): FilesystemIdentity | undefined {
  if (stat.ino <= 0n || stat.dev < 0n) return undefined;
  return {
    platform: process.platform === "win32" ? "windows" : "unix",
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  };
}

export function readFilesystemIdentity(path: string): FilesystemIdentity | undefined {
  try {
    return identityFromStat(lstatSync(path, { bigint: true }));
  } catch {
    return undefined;
  }
}

export function sameFilesystemIdentity(
  expected: FilesystemIdentity | undefined,
  actual: FilesystemIdentity | undefined,
): boolean {
  return (
    validFilesystemIdentity(expected) &&
    validFilesystemIdentity(actual) &&
    expected.platform === actual.platform &&
    expected.device === actual.device &&
    expected.inode === actual.inode
  );
}
