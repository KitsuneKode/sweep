import { rmSync, unlinkSync } from "node:fs";
import type { CleanResult, ScanEntry } from "./types.js";

/**
 * Delete all entries in the list.
 *
 * Symlinks are removed with unlinkSync (removes the link entry, not the target).
 * Directories are removed with rmSync({ recursive: true, force: true }).
 *
 * Returns a CleanResult with stats. Never throws — failed entries are collected.
 */
export async function clean(
  entries: ScanEntry[],
  onProgress?: (entry: ScanEntry, index: number, total: number) => void,
): Promise<CleanResult> {
  const startTime = Date.now();
  const deleted: ScanEntry[] = [];
  const failedPaths: Array<{ path: string; error: string }> = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;

    try {
      if (entry.isSymlink) {
        // IMPORTANT: unlinkSync removes the symlink entry itself.
        // rmSync with recursive:true on a symlink would follow the link.
        unlinkSync(entry.path);
      } else {
        rmSync(entry.path, { recursive: true, force: true });
      }
      deleted.push(entry);
    } catch (err) {
      failedPaths.push({
        path: entry.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    onProgress?.(entry, i, entries.length);
  }

  return {
    deleted,
    failedPaths,
    // Use estimatedBytes for freed — we can't measure actual freed bytes post-deletion
    totalBytesFreed: deleted.reduce((sum, e) => sum + e.estimatedBytes, 0),
    durationMs: Date.now() - startTime,
  };
}
