import { rm, unlink } from "node:fs/promises";
import type { CleanResult, PathFailure, ScanEntry } from "@kitsunekode/sweep-protocol";
import { mapPool } from "./async-pool.js";

const DELETE_CONCURRENCY = 4;

/**
 * Delete all entries in the list with bounded concurrency.
 *
 * Symlinks are removed with unlink (removes the link entry, not the target).
 * Directories are removed with rm({ recursive: true, force: true }).
 *
 * Returns a CleanResult with stats. Never throws — failed entries are collected.
 */
export async function clean(
  entries: ScanEntry[],
  onProgress?: (entry: ScanEntry, index: number, total: number) => void,
): Promise<CleanResult> {
  const startTime = Date.now();
  const deleted: ScanEntry[] = [];
  const failedPaths: PathFailure[] = [];

  await mapPool(entries, DELETE_CONCURRENCY, async (entry, index) => {
    try {
      if (entry.isSymlink) {
        await unlink(entry.path);
      } else {
        await rm(entry.path, { recursive: true, force: true });
      }
      deleted.push(entry);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failedPaths.push({
        path: entry.path,
        code: classifyFilesystemFailure(error),
        error,
      });
    }

    onProgress?.(entry, index, entries.length);
    return entry;
  });

  return {
    deleted,
    failedPaths,
    totalBytesFreed: deleted.reduce((sum, e) => sum + e.estimatedBytes, 0),
    durationMs: Date.now() - startTime,
  };
}

function classifyFilesystemFailure(error: string): PathFailure["code"] {
  if (error.includes("ENOENT")) return "missing";
  if (error.includes("EACCES") || error.includes("EPERM")) return "permission_denied";
  if (error.includes("EBUSY")) return "busy";
  return "filesystem_error";
}
