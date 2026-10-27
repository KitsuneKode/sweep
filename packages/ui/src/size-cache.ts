import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { sweepConfigDir } from "@kitsunekode/sweep-core/config";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";

/**
 * Sizes from the last scan, so the terminal UI can show a number the moment
 * a folder is found instead of after it is measured. Display only: a cached
 * size is used only when the folder's filesystem identity still matches, it
 * renders as an estimate (`~`), and the fresh measurement replaces it within
 * the same scan. The CLI and every removal never read this file.
 */

const FILE = "size-cache.json";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 50_000;

interface Entry {
  device: string;
  inode: string;
  bytes: number;
}
export type SizeCache = ReadonlyMap<string, Entry>;

function owned(meta: Stats): boolean {
  return (
    !meta.isSymbolicLink() &&
    (!process.getuid || meta.uid === process.getuid()) &&
    (process.platform === "win32" || (meta.mode & 0o022) === 0)
  );
}

function valid(
  value: unknown,
): value is { version: 1; entries: [string, string, string, number][] } {
  if (typeof value !== "object" || value === null) return false;
  const data = value as { version?: unknown; entries?: unknown };
  return data.version === 1 && Array.isArray(data.entries) && data.entries.length <= MAX_ENTRIES;
}

/** Missing, malformed or unsafe files read as an empty cache. */
export function loadSizeCache(root = sweepConfigDir()): SizeCache {
  const cache = new Map<string, Entry>();
  let fd: number | undefined;
  try {
    const path = join(root, FILE);
    const before = lstatSync(path);
    if (!before.isFile() || !owned(before) || before.size > MAX_BYTES) return cache;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const meta = fstatSync(fd);
    if (meta.dev !== before.dev || meta.ino !== before.ino || meta.size > MAX_BYTES) return cache;
    const buffer = Buffer.alloc(meta.size);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, null);
      if (count === 0) break;
      read += count;
    }
    const value: unknown = JSON.parse(buffer.subarray(0, read).toString("utf8"));
    if (!valid(value)) return cache;
    for (const row of value.entries) {
      const [path, device, inode, bytes] = row;
      if (
        typeof path === "string" &&
        typeof device === "string" &&
        typeof inode === "string" &&
        Number.isSafeInteger(bytes) &&
        bytes >= 0
      ) {
        cache.set(path, { device, inode, bytes });
      }
    }
  } catch {
    /* no cache: every size is measured, as before */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to recover */
      }
    }
  }
  return cache;
}

/** The cached size for a freshly found candidate, if its folder is the same one. */
export function cachedBytes(cache: SizeCache, candidate: ScanCandidate): number | undefined {
  const entry = cache.get(candidate.path);
  const identity = candidate.identity;
  if (!entry || !identity) return undefined;
  return entry.device === identity.device && entry.inode === identity.inode
    ? entry.bytes
    : undefined;
}

/** Keep the sizes this scan measured. Failures are silent: it is only a speed-up. */
export function saveSizeCache(candidates: readonly ScanCandidate[], root = sweepConfigDir()): void {
  const entries = candidates
    .filter((candidate) => candidate.identity && candidate.bytesKnown !== false)
    .slice(0, MAX_ENTRIES)
    .map((candidate) => [
      candidate.path,
      candidate.identity!.device,
      candidate.identity!.inode,
      candidate.estimatedBytes,
    ]);
  const body = JSON.stringify({ version: 1, entries });
  if (Buffer.byteLength(body) > MAX_BYTES) return;
  const dir = resolve(root);
  const temporary = join(dir, `.size-cache-${randomUUID()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const meta = lstatSync(dir);
    if (!meta.isDirectory() || !owned(meta)) return;
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(fd, body, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(dir, FILE));
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      /* already gone */
    }
  }
}
