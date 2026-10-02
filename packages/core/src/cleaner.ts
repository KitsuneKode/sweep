import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { CleanResult, PathFailure, ScanEntry } from "@kitsunekode/sweep-protocol";
import { mapPool } from "./async-pool.js";
import { checkedBytes } from "./resource-budget.js";
import {
  isPathWithinRoot,
  isReparsePointOrSymlink,
  pathHasProtectedVcsSegment,
} from "./guardrails.js";

const DELETE_CONCURRENCY = 4;
const CASE_FOLD_PATHS = process.platform === "darwin" || process.platform === "win32";

export interface CleanOptions {
  /** Fires immediately before the remove or trash rename, while that path is in flight. */
  onBegin?: ((entry: ScanEntry, index: number, total: number) => void) | undefined;
  /**
   * Fires once per processed entry with `succeeded` = whether it actually
   * deleted/moved - a failed entry must not paint as freed bytes.
   */
  onProgress?:
    | ((entry: ScanEntry, index: number, total: number, succeeded: boolean) => void)
    | undefined;
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
  /**
   * Root that each entry's parent must resolve inside of at delete time.
   * Revalidation checks run once at plan load; a symlinked ancestor planted
   * afterwards would redirect rm/rename outside the target. The parent is
   * re-canonicalized inside each worker immediately before the delete so the
   * escape window shrinks to the syscall itself (a fully race-free delete
   * needs fd-relative operations, which Node's fs API doesn't expose).
   */
  containmentRoot?: string | undefined;
}

/**
 * Comparison key for dedupe: resolved+normalized, case-folded where the
 * filesystem folds. A forged plan can smuggle duplicates through spelling
 * variants (`a/../b`, `\\`, case) that byte-order compare differently.
 */
export function dedupeKey(path: string): string {
  const normalized = normalize(resolve(path));
  return CASE_FOLD_PATHS ? normalized.toLowerCase() : normalized;
}

/**
 * Filter out candidate entries that are contained within an ancestor candidate
 * that is already scheduled for recursive removal - and exact-path duplicates.
 * A crafted plan can list the same path under two ids; concurrent rm on the
 * same target then double-counts deletions in the report.
 *
 * Sort is lexicographic so a parent path is retained before any children that
 * start with that prefix. Ancestor probing walks the entry's own parent chain
 * against a set of retained directory keys: O(n * path-depth), not O(n²).
 */
export function deduplicateNestedEntries(entries: ScanEntry[]): ScanEntry[] {
  // Sort shallowest paths first. Byte order, not localeCompare: ICU collation
  // is locale-dependent and would sort differently from the Rust engine's
  // byte-wise cmp, producing different retained sets for paths that differ
  // only in case or punctuation. Keys are computed once per entry - inside
  // the comparator they'd be O(n log n) computations instead of O(n).
  const keyed = entries.map((entry) => ({ key: dedupeKey(entry.path), entry }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const retained: ScanEntry[] = [];
  const retainedExact = new Set<string>();
  const retainedDirs = new Set<string>();

  for (const { key, entry } of keyed) {
    if (retainedExact.has(key)) continue;
    let insideRetained = false;
    let dir = dirname(key);
    // dirname("/") is "/" - stop when the parent stops shrinking or the
    // walk would spin forever at the filesystem root.
    while (dir.length < key.length) {
      if (retainedDirs.has(dir)) {
        insideRetained = true;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (insideRetained) continue;
    retainedExact.add(key);
    if (entry.entryType === "directory" && !entry.isSymlink) {
      retainedDirs.add(key);
    }
    retained.push(entry);
  }

  return retained;
}

/** lstat-based existence check - a dangling symlink still occupies the slot. */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move an entry into the trash dir, preserving its path relative to
 * `trashRoot`. `rename` on a symlink moves the link itself, never the target.
 * A path outside `trashRoot` or an absolute relative result is refused -
 * the trash layout must stay inside `trashDir`.
 *
 * `realTrashDir` is the trash root's identity pinned once in `clean()`:
 * re-resolving it per move would follow a post-validation swap and the
 * "destination under wherever trashDir currently resolves" check becomes
 * tautological. The pin is compared per move so a swapped trash root fails.
 */
async function moveToTrash(
  entry: ScanEntry,
  trashDir: string,
  trashRoot: string,
  realTrashDir: string | undefined,
): Promise<void> {
  const rel = relative(trashRoot, entry.path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`trash destination escapes root for ${entry.path}`);
  }
  // POSIX rename silently replaces an existing destination - leftovers from a
  // prior trash run or case-variant duplicates must not be clobbered, so bump
  // a suffix until the slot is free. lstat catches dangling links too.
  let destination = join(trashDir, rel);
  for (let suffix = 2; pathExists(destination); suffix++) {
    destination = join(trashDir, `${rel}-${suffix}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  // A symlink planted inside the trash layout would redirect the rename -
  // verify the real parent still lands under the PINNED real trash dir, and
  // that trashDir itself still resolves to the same place it did at pin time.
  const realParent = realpathSync(dirname(destination));
  if (
    realTrashDir === undefined ||
    realpathSync(trashDir) !== realTrashDir ||
    (!isPathWithinRoot(realParent, realTrashDir) && realParent !== realTrashDir)
  ) {
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
 * Returns a CleanResult with stats. Never throws for per-entry failures -
 * failed entries are collected. When `isCancelled` turns true, unprocessed
 * entries are skipped: they appear in neither `deleted` nor `failedPaths`,
 * so callers can detect interruption via
 * `deleted.length + failedPaths.length < deduplicated.length`.
 */
export async function clean(
  entries: ScanEntry[],
  options: CleanOptions = {},
): Promise<CleanResult> {
  const startTime = Date.now();
  const deleted: ScanEntry[] = [];
  const failedPaths: PathFailure[] = [];

  if ((options.trashDir === undefined) !== (options.trashRoot === undefined)) {
    throw new Error("clean(): trashDir and trashRoot must be set together");
  }

  // Resolve the containment root once - every worker re-canonicalizes the
  // entry's *parent* against it right before the delete. A supplied root
  // that cannot resolve is NOT "no check": it fails every entry closed.
  const containmentRequired = options.containmentRoot !== undefined;
  let realContainmentRoot: string | undefined;
  if (containmentRequired) {
    try {
      realContainmentRoot = realpathSync(options.containmentRoot!);
    } catch {
      realContainmentRoot = undefined;
    }
  }

  // Pin the trash root's identity once: moveToTrash compares every move
  // against this value, so a trashDir swapped for a symlink mid-apply fails
  // instead of re-resolving to wherever the attacker pointed it. The dir is
  // created first - a not-yet-existing trash root cannot be canonicalized.
  let realTrashDir: string | undefined;
  if (options.trashDir) {
    try {
      mkdirSync(options.trashDir, { recursive: true });
      realTrashDir = realpathSync(options.trashDir);
    } catch {
      realTrashDir = undefined;
    }
  }

  const deduplicated = deduplicateNestedEntries(entries);

  await mapPool(
    deduplicated,
    DELETE_CONCURRENCY,
    async (entry, index) => {
      let succeeded = false;
      try {
        // Re-lstat before touching anything: an entry that vanished since
        // validation must report "missing" (rm force:true never complains),
        // and a type flip must not be deleted as the wrong kind.
        const current = lstatSync(entry.path);
        const nowSymlink = current.isSymbolicLink();
        const nowType = nowSymlink ? "symlink" : current.isDirectory() ? "directory" : "file";
        if (nowSymlink !== entry.isSymlink) {
          throw Object.assign(new Error(`entry symlink state changed since validation`), {
            code: "ESYMLINKCHANGED",
          });
        }
        if (nowType !== entry.entryType) {
          throw Object.assign(new Error(`entry type changed since validation`), {
            code: "ECHANGED",
          });
        }
        if (containmentRequired) {
          // Fail closed: a supplied root that no longer resolves means the
          // canonical checks cannot run at all - refuse rather than follow.
          if (realContainmentRoot === undefined) {
            throw Object.assign(new Error(`containment root could not be resolved`), {
              code: "EOUTSIDE",
            });
          }
          // Shrink the validate-then-delete race: if an ancestor directory was
          // swapped for a symlink after revalidation, the canonical parent no
          // longer lands under the root - refuse rather than follow.
          const realParent = realpathSync(dirname(entry.path));
          if (!isPathWithinRoot(realParent, realContainmentRoot)) {
            throw Object.assign(new Error(`parent resolves outside containment root`), {
              code: "EOUTSIDE",
            });
          }
          if (pathHasProtectedVcsSegment(realParent)) {
            throw Object.assign(new Error("parent resolves inside protected VCS metadata"), {
              code: "EPROTECTED",
            });
          }
        }
        try {
          options.onBegin?.(entry, index, deduplicated.length);
        } catch {
          // A throwing progress sink must not abort the delete loop.
        }
        if (options.trashDir && options.trashRoot) {
          await moveToTrash(entry, options.trashDir, options.trashRoot, realTrashDir);
        } else if (
          entry.isSymlink ||
          (process.platform === "win32" && isReparsePointOrSymlink(entry.path))
        ) {
          try {
            await unlink(entry.path);
          } catch (err) {
            // Windows refuses unlink on dir symlinks/junctions; rmdir removes
            // the link itself. Re-verify the leaf is still a reparse point
            // first - a swap to a real dir must not be removed by the
            // fallback. On POSIX unlink errors propagate with their real code.
            if (process.platform !== "win32" || !isReparsePointOrSymlink(entry.path)) {
              throw err;
            }
            await rmdir(entry.path);
          }
        } else {
          await rm(entry.path, { recursive: true, force: true });
        }
        succeeded = true;
        deleted.push(entry);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const error = err instanceof Error ? err.message : String(err);
        failedPaths.push({
          path: entry.path,
          code: classifyFilesystemFailure(code),
          error,
        });
      }

      try {
        options.onProgress?.(entry, index, deduplicated.length, succeeded);
      } catch {
        // A throwing progress sink must not abort the delete loop.
      }
      return entry;
    },
    options.isCancelled,
  );

  return {
    deleted,
    failedPaths,
    totalBytesFreed: deleted.reduce((sum, e) => checkedBytes(sum, e.estimatedBytes), 0),
    durationMs: Date.now() - startTime,
  };
}

function classifyFilesystemFailure(code: string | undefined): PathFailure["code"] {
  // err.code is authoritative - a path literally containing "ENOENT" must not
  // shadow the real failure class. Non-errno throws (plain Errors from the
  // trash escape checks) carry no code and land in filesystem_error.
  if (code === "ENOENT") return "missing";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  if (code === "EBUSY") return "busy";
  if (code === "EOUTSIDE") return "outside_target";
  if (code === "EPROTECTED") return "protected_path";
  if (code === "ECHANGED") return "changed_entry_type";
  if (code === "ESYMLINKCHANGED") return "changed_symlink_state";
  return "filesystem_error";
}
