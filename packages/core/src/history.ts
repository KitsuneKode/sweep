import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
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

export function historyFilePath(): string {
  return join(sweepConfigDir(), HISTORY_FILE);
}

/**
 * Best-effort append - history is a nicety, never a reason to fail an apply.
 * Returns false when the write could not be completed.
 */
export function appendHistory(entry: CleanupHistoryEntry): boolean {
  try {
    const dir = sweepConfigDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, HISTORY_FILE), `${JSON.stringify(entry)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Read history oldest-first. Malformed lines are skipped. Files larger than
 * MAX_READ_BYTES are tail-sliced - the first partial line is dropped because
 * every entry is a complete JSON document on its own line.
 */
export function readHistory(limit = 200): CleanupHistoryEntry[] {
  let raw: string;
  try {
    const filePath = historyFilePath();
    raw = readFileSync(filePath, "utf-8");
    if (statSync(filePath).size > MAX_READ_BYTES) {
      raw = raw.slice(raw.length - MAX_READ_BYTES);
    }
  } catch {
    return [];
  }

  const entries: CleanupHistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as CleanupHistoryEntry;
      if (
        typeof parsed.ts === "string" &&
        typeof parsed.targetDir === "string" &&
        typeof parsed.deleted === "number" &&
        typeof parsed.bytesFreed === "number"
      ) {
        entries.push(parsed);
      }
    } catch {
      // Corrupt line - skip it.
    }
  }
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
