import { rm, rmdir, unlink } from "node:fs/promises";
import type { CleanResult, PathFailure, ScanEntry } from "@kitsunekode/sweep-protocol";
import { mapPool } from "./async-pool.js";
import { isReparsePointOrSymlink } from "./guardrails.js";

const DELETE_CONCURRENCY = 4;

/**
 * Filter out candidate entries that are contained within an ancestor candidate
 * that is already scheduled for recursive removal. Sort is lexicographic so a
 * parent path is retained before any children that start with that prefix.
 */
export function deduplicateNestedEntries(entries: ScanEntry[]): ScanEntry[] {
  // Sort shallowest paths first
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const retained: ScanEntry[] = [];

  for (const entry of sorted) {
    const isInsideRetained = retained.some(
      (parent) =>
        parent.entryType === "directory" &&
        !parent.isSymlink &&
        (entry.path.startsWith(`${parent.path}/`) || entry.path.startsWith(`${parent.path}\\`)),
    );
    if (!isInsideRetained) {
      retained.push(entry);
    }
  }

  return retained;
}

/**
 * Delete all entries in the list with bounded concurrency.
 *
 * Symlinks are removed with unlink (removes the link entry, not the target).
 * Reparse points / NTFS junctions on Windows are unlinked/removed safely without recursion.
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

  const deduplicated = deduplicateNestedEntries(entries);

  await mapPool(deduplicated, DELETE_CONCURRENCY, async (entry, index) => {
    try {
      if (
        entry.isSymlink ||
        (process.platform === "win32" && isReparsePointOrSymlink(entry.path))
      ) {
        try {
          await unlink(entry.path);
        } catch {
          await rmdir(entry.path);
        }
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

    onProgress?.(entry, index, deduplicated.length);
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
