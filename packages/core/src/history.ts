import {
  constants,
  closeSync,
  fstatSync,
  fchmodSync,
  mkdirSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sweepConfigDir } from "./config.js";

export interface CleanupHistoryEntry {
  /** ISO timestamp of the apply. */
  ts: string;
  targetDir: string;
  engine: string;
  deleted: number;
  bytesFreed: number;
  failed: number;
  interrupted: boolean;
  /** Trash dir (absolute) when entries were moved, not deleted. */
  trashDir?: string;
}

export interface HistorySummary {
  sessions: number;
  totalDeleted: number;
  totalBytesFreed: number;
  totalFailed: number;
  lastAt: string | null;
}

const HISTORY_FILE = "history.jsonl";
/** Cap history reads - stats stay cheap no matter how long the log gets. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Rotate whole files; never rewrite a concurrently appended log. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVES = 4;
const ARCHIVE = /^history\.\d{13}\.[a-f0-9-]+\.jsonl$/;

export function historyFilePath(): string {
  return join(sweepConfigDir(), HISTORY_FILE);
}

function archiveNames(): string[] {
  return readdirSync(sweepConfigDir())
    .filter((name) => ARCHIVE.test(name))
    .sort()
    .reverse();
}

/** Best-effort private append. Rotation moves whole files, preserving writes
 * from processes already holding an append descriptor to the renamed inode. */
export function appendHistory(entry: CleanupHistoryEntry): boolean {
  let fd: number | undefined;
  try {
    if (!validEntry(entry)) return false;
    const payload = Buffer.from(`\n${JSON.stringify(entry)}\n`);
    if (payload.length > 64 * 1024) return false;
    const dir = sweepConfigDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = historyFilePath();
    try {
      if (!lstatSync(file).isFile()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    fd = openSync(
      file,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NONBLOCK |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const handle = fstatSync(fd);
    if (!handle.isFile() || handle.nlink > 1) return false;
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    if (writeSync(fd, payload) !== payload.length) return false;
    const size = fstatSync(fd).size;
    closeSync(fd);
    fd = undefined;
    if (size > MAX_FILE_BYTES) {
      // Unique names prevent concurrent rotators from overwriting archives.
      // A competing writer may create a fresh active log: moving that whole
      // file too is safe; no accepted record is lost to a tail rewrite.
      try {
        renameSync(file, join(dir, `history.${Date.now()}.${randomUUID()}.jsonl`));
      } catch {
        /* another rotator */
      }
      for (const name of archiveNames().slice(MAX_ARCHIVES)) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          /* concurrent retention */
        }
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function validEntry(value: unknown): value is CleanupHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as CleanupHistoryEntry;
  return (
    typeof e.ts === "string" &&
    Number.isFinite(Date.parse(e.ts)) &&
    typeof e.targetDir === "string" &&
    typeof e.engine === "string" &&
    [e.deleted, e.bytesFreed, e.failed].every((n) => Number.isSafeInteger(n) && n >= 0) &&
    typeof e.interrupted === "boolean" &&
    (e.trashDir === undefined || typeof e.trashDir === "string")
  );
}

/** Open/fstat/read the same regular handle; allocate only the bounded tail. */
function readTail(file: string, budget: number): { data: Buffer; read: number } {
  let fd: number | undefined;
  try {
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile()) return { data: Buffer.alloc(0), read: 0 };
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    const identity = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || identity.dev !== before.dev || identity.ino !== before.ino)
      return { data: Buffer.alloc(0), read: 0 };
    const start = Math.max(0, stat.size - budget);
    const buffer = Buffer.alloc(Math.min(budget, stat.size));
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (!count) break;
      read += count;
    }
    const tail = buffer.subarray(0, read);
    if (!start) return { data: tail, read };
    const newline = tail.indexOf(10);
    return { data: newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1), read };
  } catch {
    return { data: Buffer.alloc(0), read: 0 };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Retained history, oldest first. Read at most 8 MiB across active/archives;
 * oversized, partial, malformed and unsafe records never become totals. */
export function readHistory(limit = 200): CleanupHistoryEntry[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  let names: string[];
  try {
    names = [HISTORY_FILE, ...archiveNames().slice(0, MAX_ARCHIVES)];
  } catch {
    return [];
  }
  let budget = MAX_READ_BYTES;
  const entries: CleanupHistoryEntry[] = [];
  for (const name of names) {
    if (budget <= 0) break;
    const raw = readTail(join(sweepConfigDir(), name), budget);
    // Charge the requested tail, including discarded partial-line bytes.
    budget -= raw.read;
    for (const line of raw.data.toString("utf8").split("\n")) {
      if (!line || Buffer.byteLength(line) > 64 * 1024) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (validEntry(parsed)) entries.push(parsed);
      } catch {
        /* malformed record */
      }
    }
  }
  entries.sort((a, b) => a.ts.localeCompare(b.ts));
  return entries.slice(-limit);
}

export function summarizeHistory(entries: CleanupHistoryEntry[]): HistorySummary {
  return {
    sessions: entries.length,
    totalDeleted: entries.reduce((sum, e) => sum + e.deleted, 0),
    totalBytesFreed: entries.reduce((sum, e) => sum + e.bytesFreed, 0),
    totalFailed: entries.reduce((sum, e) => sum + e.failed, 0),
    lastAt: entries.length > 0 ? (entries[entries.length - 1]?.ts ?? null) : null,
  };
}
