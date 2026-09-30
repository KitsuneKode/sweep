import { mkdirSync, realpathSync } from "node:fs";
import { rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { CleanResult, PathFailure, ScanEntry } from "@kitsunekode/sweep-protocol";
import { mapPool } from "./async-pool.js";
import { isPathWithinRoot, isReparsePointOrSymlink } from "./guardrails.js";

const DELETE_CONCURRENCY = 4;

export interface CleanOptions {
  onProgress?: ((entry: ScanEntry, index: number, total: number) => void) | undefined;
  /**
   * JS engine: checked before each delete; true stops scheduling new work.
   * Unprocessed entries appear in neither `deleted` nor `failedPaths`.
   */
  isCancelled?: (() => boolean) | undefined;
  /**
   * When set, entries are moved into this directory instead of deleted.
   * `trashDir` must live on the same filesystem as the entries - moves are
   * atomic renames, never copy-and-delete.
   */
  trashDir?: string | undefined;
  /**
   * Root that entry paths are relativized against for the trash layout.
   * Required when `trashDir` is set; entries outside it are failed rather
   * than moved.
   */
  trashRoot?: string | undefined;
}

/**
 * Filter out candidate entries that are contained within an ancestor candidate
 * that is already scheduled for recursive removal - and exact-path duplicates.
 * A crafted plan can list the same path under two ids; concurrent rm on the
 * same target then double-counts deletions in the report.
 * Sort is lexicographic so a parent path is retained before any children that
 * start with that prefix.
 */
export function deduplicateNestedEntries(entries: ScanEntry[]): ScanEntry[] {
  // Sort shallowest paths first
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const retained: ScanEntry[] = [];

  for (const entry of sorted) {
    const isInsideRetained = retained.some(
      (parent) =>
        parent.path === entry.path ||
        (parent.entryType === "directory" &&
          !parent.isSymlink &&
          (entry.path.startsWith(`${parent.path}/`) || entry.path.startsWith(`${parent.path}\\`))),
    );
    if (!isInsideRetained) {
      retained.push(entry);
    }
  }

  return retained;
}

/**
 * Move an entry into the trash dir, preserving its path relative to
 * `trashRoot`. `rename` on a symlink moves the link itself, never the target.
 * A path outside `trashRoot` or an absolute relative result is refused -
 * the trash layout must stay inside `trashDir`.
 */
async function moveToTrash(entry: ScanEntry, trashDir: string, trashRoot: string): Promise<void> {
  const rel = relative(trashRoot, entry.path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`trash destination escapes root for ${entry.path}`);
  }
  const destination = join(trashDir, rel);
  mkdirSync(dirname(destination), { recursive: true });
  // A symlink planted inside the trash layout would redirect the rename -
  // verify the real parent still lands under the real trash dir.
  const realParent = realpathSync(dirname(destination));
  const realTrash = realpathSync(trashDir);
  if (!isPathWithinRoot(realParent, realTrash) && realParent !== realTrash) {
    throw new Error(`trash destination escapes ${trashDir} for ${entry.path}`);
  }
  await rename(entry.path, destination);
}

/**
 * Delete all entries in the list with bounded concurrency - or move them to
 * `options.trashDir` when trash mode is requested.
 *
 * Symlinks are removed with unlink (removes the link entry, not the target).
 * Reparse points / NTFS junctions on Windows are unlinked/removed safely without recursion.
 * Directories are removed with rm({ recursive: true, force: true }).
 *
 * Returns a CleanResult with stats. Never throws - failed entries are collected.
 * When `isCancelled` turns true, unprocessed entries are skipped: they appear
 * in neither `deleted` nor `failedPaths`, so callers can detect interruption
 * via `deleted.length + failedPaths.length < deduplicated.length`.
 */
export async function clean(
  entries: ScanEntry[],
  options: CleanOptions = {},
): Promise<CleanResult> {
  const startTime = Date.now();
  const deleted: ScanEntry[] = [];
  const failedPaths: PathFailure[] = [];

  const deduplicated = deduplicateNestedEntries(entries);

  await mapPool(
    deduplicated,
    DELETE_CONCURRENCY,
    async (entry, index) => {
      try {
        if (options.trashDir && options.trashRoot) {
          await moveToTrash(entry, options.trashDir, options.trashRoot);
        } else if (
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

      options.onProgress?.(entry, index, deduplicated.length);
      return entry;
    },
    options.isCancelled,
  );

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
