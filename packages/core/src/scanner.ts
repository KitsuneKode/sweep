import { lstatSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type {
  ScanEntry,
  ScanResult,
  SweepConfig,
  ScanLimits,
  FilesystemIdentity,
  ResourceProfile,
} from "@kitsunekode/sweep-protocol";
import { SCAN_RESOURCE_PROFILES } from "@kitsunekode/sweep-protocol";
import {
  ResourceBudget,
  ResourceLimitError,
  checkedBytes,
  discoveryCandidateFieldChars,
} from "./resource-budget.js";
import { toCandidate } from "./planner.js";
import {
  DirectoryReaderRuntimeError,
  directoryEntries,
  disposeDirectoryReader,
} from "./directory-reader.js";

function isFatalScanError(error: unknown): boolean {
  return error instanceof ResourceLimitError || error instanceof DirectoryReaderRuntimeError;
}
import { mapPool } from "./async-pool.js";
import { SCAN_CONCURRENCY } from "./scan-concurrency.js";
import { compileIgnoreMatcher } from "./config.js";
import { compileGlobMatchers } from "./glob-match.js";
import { isReparsePointOrSymlink } from "./guardrails.js";
import { identityFromStat, readFilesystemIdentity } from "./filesystem-identity.js";

export interface ScanHooks {
  onStarted?: (targetIdentity: FilesystemIdentity | undefined) => void;
  /** Fired as soon as a matching entry is discovered (bytes may be 0 until sized). */
  onEntry?: (entry: ScanEntry) => void;
  /** Fired after size estimation completes for an entry. */
  onEntrySized?: (entry: ScanEntry) => void;
  /** Fired periodically with walk progress (dirs visited, matches found, dirs skipped). */
  onProgress?: (info: {
    scannedDirs: number;
    found: number;
    skippedDirs: number;
    /** Candidates whose size has resolved so far. */
    sizedCount?: number;
    /** Directory being walked, relative to the scan target ("." for the root). */
    currentDir?: string;
  }) => void;
  /** Optional downstream backpressure. Only streaming CLI consumers need this. */
  waitForConsumer?: () => Promise<void> | undefined;
  /** Optional cancellation signal for long-running scans. */
  signal?: AbortSignal;
  /** Optional resource bounds; defaults protect ordinary scans. */
  limits?: Partial<ScanLimits>;
  resourceProfile?: ResourceProfile | undefined;
}

/** VCS/metadata dirs - never descend (major win on large trees). */
const SKIP_DIR_NAMES = new Set([".git", ".svn", ".hg", ".bzr", ".jj", ".sl", "_darcs", ".pijul"]);

// macOS and Windows filesystems are case-insensitive, so `.GIT` is the same
// protected directory as `.git` - compare lowercase there.
const skipDirName = (name: string): boolean =>
  SKIP_DIR_NAMES.has(
    process.platform === "darwin" || process.platform === "win32" ? name.toLowerCase() : name,
  );

const TRAVERSAL_CONCURRENCY = SCAN_CONCURRENCY.traversal;
/**
 * Dirents seen per directory before the listing is declared untrustworthy.
 * No budget otherwise bounds enumeration: a hostile FUSE/NFS dir returning
 * an endless stream would spin a scan forever with flat memory.
 */
const MAX_DIR_ENTRIES = 4_000_000;
const SIZE_CONCURRENCY = SCAN_CONCURRENCY.metadata;
/** Max sizing batches in flight while the walk continues. */
const SIZE_MAX_INFLIGHT = SCAN_CONCURRENCY.sizingBatches;

// ─── Pattern matching ─────────────────────────────────────────────────────────

function compileMatcher(patterns: string[]): (name: string) => boolean {
  const isCaseInsensitive = process.platform === "darwin" || process.platform === "win32";
  // Linear `*`/`?` matcher, not RegExp - a hostile pattern cannot put the
  // walk into regex backtracking before it starts (audit A01).
  return compileGlobMatchers(patterns, isCaseInsensitive);
}

// ─── Size estimation ──────────────────────────────────────────────────────────

const platform = process.platform;
const SIZE_BATCH_SIZE = 50;
/** Bound a sizing batch by total path bytes so deep monorepo paths split sooner. */
const SIZE_BATCH_PATH_BUDGET = 96 * 1024;

/** mtime of the path itself (not its target), or undefined when it cannot be read. */
async function discoveryMetadata(path: string) {
  try {
    const stat = await lstat(path, { bigint: true });
    const mtimeMs = Number(stat.mtimeMs);
    return {
      identity: identityFromStat(stat),
      modifiedMs: Number.isSafeInteger(mtimeMs) && mtimeMs >= 0 ? mtimeMs : undefined,
    };
  } catch {
    return { identity: undefined, modifiedMs: undefined };
  }
}

function batchPathCost(paths: string[]): number {
  let bytes = 3; // fixed batch overhead
  for (const path of paths) bytes += path.length + 1;
  return bytes;
}

function splitEntriesByPathBudget(entries: ScanEntry[]): ScanEntry[][] {
  const chunks: ScanEntry[][] = [];
  let current: ScanEntry[] = [];
  for (const entry of entries) {
    const next = [...current, entry];
    if (
      current.length > 0 &&
      (next.length > SIZE_BATCH_SIZE ||
        batchPathCost(next.map((item) => item.path)) > SIZE_BATCH_PATH_BUDGET)
    ) {
      chunks.push(current);
      current = [entry];
    } else {
      current = next;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

interface SubtreeSize {
  bytes: number;
  /** Bytes exclusive to this entry (excluding hardlinks shared outside it). */
  uniqueBytes: number;
  /** `false` when part of the subtree could not be read - `bytes` is a floor. */
  complete: boolean;
}

interface SharedInode {
  dev: bigint;
  ino: bigint;
  size: number;
  nlink: bigint;
  seen: bigint;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Bounded scan-wide hardlink deduplicator (by `(dev, ino)`).
 * Mirrors Rust `sweep_fs::HardlinkTracker` for exact engine parity.
 *
 * Uses per-device maps of numeric inode keys to dense parallel arrays so
 * large pnpm/Bun stores avoid per-inode string keys and object allocations,
 * and charges each retained inode to `ResourceBudget` when provided.
 */
export class HardlinkTracker {
  private singleLinkBytes = 0;
  private readonly byDevice = new Map<bigint, Map<number | bigint, number>>();
  private readonly sizes: number[] = [];
  private readonly nlinks: number[] = [];
  private readonly seens: number[] = [];
  private capped = false;
  private hasMultiLink = false;

  constructor(
    private readonly cap: number,
    private readonly budget?: ResourceBudget,
  ) {}

  recordSingleLink(size: number): void {
    if (size <= 0) return;
    this.singleLinkBytes = Math.min(Number.MAX_SAFE_INTEGER, this.singleLinkBytes + size);
  }

  recordMultiLink(dev: bigint, ino: bigint, size: number, nlink: bigint, count = 1n): void {
    if (size <= 0 || count <= 0n) return;
    this.hasMultiLink = true;
    if (ino === 0n) {
      this.capped = true;
      return;
    }
    const inoKey: number | bigint = ino <= MAX_SAFE_BIGINT ? Number(ino) : ino;
    const seenDelta = count > MAX_SAFE_BIGINT ? Number.MAX_SAFE_INTEGER : Number(count);
    let deviceMap = this.byDevice.get(dev);
    const existingSlot = deviceMap?.get(inoKey);
    if (existingSlot !== undefined) {
      this.seens[existingSlot] = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.seens[existingSlot]! + seenDelta,
      );
      return;
    }
    if (
      this.sizes.length >= this.cap ||
      (this.budget !== undefined && !this.budget.hardlinkIdentity())
    ) {
      this.capped = true;
      return;
    }
    if (!deviceMap) {
      deviceMap = new Map<number | bigint, number>();
      this.byDevice.set(dev, deviceMap);
    }
    const slot = this.sizes.length;
    deviceMap.set(inoKey, slot);
    this.sizes.push(size);
    this.nlinks.push(nlink > MAX_SAFE_BIGINT ? Number.MAX_SAFE_INTEGER : Number(nlink));
    this.seens.push(seenDelta);
  }

  markCapped(): void {
    this.capped = true;
  }

  hasMultiLinkInodes(): boolean {
    return this.hasMultiLink;
  }

  uniqueTotalBytes(): number {
    let total = this.singleLinkBytes;
    for (let i = 0; i < this.sizes.length; i += 1) {
      if (this.seens[i]! >= this.nlinks[i]!) {
        total = Math.min(Number.MAX_SAFE_INTEGER, total + this.sizes[i]!);
      }
    }
    return total;
  }

  isCapped(): boolean {
    return this.capped;
  }
}

function statFallback(entryPath: string, tracker?: HardlinkTracker): SubtreeSize {
  try {
    // lstat, not stat: a symlink candidate's size is the link itself - stat
    // would report the target, misreporting freed bytes by the target's size.
    const stat = lstatSync(entryPath, { bigint: true });
    const bytes = checkedBytes(0, Number(stat.size));
    if (stat.nlink > 1n) {
      tracker?.recordMultiLink(stat.dev, stat.ino, bytes, stat.nlink);
      return { bytes, uniqueBytes: 0, complete: true };
    }
    tracker?.recordSingleLink(bytes);
    return { bytes, uniqueBytes: bytes, complete: true };
  } catch (error) {
    if (isFatalScanError(error)) throw error;
    return { bytes: 0, uniqueBytes: 0, complete: false };
  }
}

/** Async exact size so fallback walks yield to the event loop and honor abort. */
export async function exactSizeAsync(entryPath: string, signal?: AbortSignal): Promise<number> {
  return (await exactSizeDetailed(entryPath, signal)).bytes;
}

/**
 * Exact size with completeness: `complete` is `false` when any part of the
 * subtree could not be read, so `bytes` is a partial lower bound.
 */
export async function exactSizeDetailed(
  entryPath: string,
  signal?: AbortSignal,
  budget = new ResourceBudget(),
  tracker?: HardlinkTracker,
): Promise<SubtreeSize> {
  return metadataSize(entryPath, true, signal, budget, tracker);
}

/** Per-artifact hard links are counted once in apparent mode. */
export async function apparentSizeDetailed(
  entryPath: string,
  signal?: AbortSignal,
  budget = new ResourceBudget(),
  tracker?: HardlinkTracker,
): Promise<SubtreeSize> {
  return metadataSize(entryPath, false, signal, budget, tracker);
}

async function metadataSize(
  entryPath: string,
  exact: boolean,
  signal: AbortSignal | undefined,
  budget: ResourceBudget,
  tracker?: HardlinkTracker,
): Promise<SubtreeSize> {
  let bytes = 0;
  let singleLinkBytes = 0;
  let uniqueBytes = 0;
  let complete = true;
  let localCapped = false;
  let finished = false;
  // The dedup sets and stack die with this job, so they bound peak memory -
  // not a cumulative total. The walk already charged these paths against the
  // scan-wide budget; sizing bounds itself with per-job caps derived from the
  // same limits. A scan-level failure still propagates via budget.check().
  const dedupCap = budget.limits.maxIdentities;
  const pendingCap = budget.limits.maxQueuedDirs;
  const links = new Map<string, SharedInode>();
  const dirs = new Set<string>();
  const stack: (string | Buffer)[] = [];
  const price = (stat: import("node:fs").BigIntStats | import("node:fs").Stats, root = false) => {
    if (!stat.isFile() && !(stat.isSymbolicLink() && (!exact || root))) return;
    const rawSize = Number(stat.size);
    const nlink = typeof stat.nlink === "bigint" ? stat.nlink : BigInt(stat.nlink);
    if (nlink <= 1n) {
      bytes = checkedBytes(bytes, rawSize);
      singleLinkBytes = checkedBytes(singleLinkBytes, rawSize);
      uniqueBytes = checkedBytes(uniqueBytes, rawSize);
      return;
    }
    const dev = typeof stat.dev === "bigint" ? stat.dev : BigInt(stat.dev);
    const ino = typeof stat.ino === "bigint" ? stat.ino : BigInt(stat.ino);
    if (ino === 0n) {
      localCapped = true;
      complete = false;
      bytes = checkedBytes(bytes, rawSize);
      return;
    }
    const id = `${dev}:${ino}`;
    const existing = links.get(id);
    if (existing) {
      existing.seen += 1n;
      if (exact) bytes = checkedBytes(bytes, rawSize);
      return;
    }
    if (links.size >= dedupCap || !budget.sizingIdentity()) {
      // Set at cap: count the link anyway (overcount, flagged partial)
      // rather than undercounting zero or killing the scan.
      localCapped = true;
      complete = false;
      bytes = checkedBytes(bytes, rawSize);
      return;
    }
    links.set(id, { dev, ino, size: rawSize, nlink, seen: 1n });
    bytes = checkedBytes(bytes, rawSize);
  };
  if (!budget.sizingDirectory(entryPath)) return { bytes: 0, uniqueBytes: 0, complete: false };
  stack.push(entryPath);
  try {
    while (stack.length) {
      budget.check();
      if (signal?.aborted) return { bytes, uniqueBytes, complete: false };
      const path = stack.pop()!;
      budget.releaseSizingDirectory(path);
      try {
        const stat = await lstat(path, { bigint: true });
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          (platform === "win32" && isReparsePointOrSymlink(path.toString()))
        ) {
          price(stat, path === entryPath);
          continue;
        }
        if (stat.ino !== 0n) {
          const id = `${stat.dev}:${stat.ino}`;
          // Skip repeats and capped-set inserts alike - without the dedup
          // entry a hardlinked-dir cycle could recurse forever.
          if (dirs.has(id) || dirs.size >= dedupCap || !budget.sizingIdentity()) {
            complete = false;
            continue;
          }
          dirs.add(id);
        }
        const parent = Buffer.concat([Buffer.from(path), Buffer.from(sep)]);
        const processNames = async (names: Buffer[]) => {
          await mapPool(names, SIZE_CONCURRENCY, async (name) => {
            budget.check();
            if (signal?.aborted) {
              complete = false;
              return;
            }
            const child = Buffer.concat([parent, name]);
            try {
              // Ordinary leaves do not retain inode IDs. Avoid allocating a
              // BigInt for every metadata field; only hardlink identity needs it.
              let childStat: import("node:fs").Stats | import("node:fs").BigIntStats =
                await lstat(child);
              if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
                if (stack.length >= pendingCap || !budget.sizingDirectory(child)) {
                  // Job-local queue at cap - leave the rest of this subtree
                  // unsized rather than letting transient state grow unbounded.
                  complete = false;
                  return;
                }
                stack.push(child);
              } else {
                if (childStat.nlink > 1) childStat = await lstat(child, { bigint: true });
                price(childStat);
              }
            } catch (error) {
              if (isFatalScanError(error)) throw error;
              complete = false;
            }
          });
        };
        let names: Buffer[] = [];
        for await (const { name } of directoryEntries(path, budget, signal)) {
          names.push(name);
          if (names.length === 32) {
            await processNames(names);
            names = [];
          }
          if (signal?.aborted) break;
        }
        await processNames(names);
      } catch (error) {
        if (isFatalScanError(error)) throw error;
        complete = false;
      }
    }
    budget.check();
    // Any multi-link inode whose entire link set lives inside this candidate is
    // freed when this candidate is removed.
    for (const entry of links.values()) {
      if (entry.seen >= entry.nlink) {
        uniqueBytes = checkedBytes(uniqueBytes, entry.size);
      }
    }
    finished = !signal?.aborted;
    return { bytes, uniqueBytes, complete: complete && finished };
  } finally {
    budget.releaseSizingIdentities(links.size + dirs.size);
    for (const path of stack) budget.releaseSizingDirectory(path);
    if (finished && tracker) {
      tracker.recordSingleLink(singleLinkBytes);
      for (const entry of links.values()) {
        tracker.recordMultiLink(entry.dev, entry.ino, entry.size, entry.nlink, entry.seen);
      }
      if (localCapped) tracker.markCapped();
    }
  }
}

async function applyFallbackSizeAsync(
  entry: ScanEntry,
  signal?: AbortSignal,
  budget = new ResourceBudget(),
  tracker?: HardlinkTracker,
): Promise<SubtreeSize> {
  return entry.entryType === "directory"
    ? apparentSizeDetailed(entry.path, signal, budget, tracker)
    : statFallback(entry.path, tracker);
}

/** Minimal async counting semaphore for bounding subprocess concurrency. */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0 && this.waiters.length === 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolvePromise) => {
      this.waiters.push(() => {
        this.permits -= 1;
        resolvePromise();
      });
    });
  }

  release(): void {
    this.permits += 1;
    const next = this.waiters.shift();
    next?.();
  }
}

/**
 * Streaming metadata size estimator with bounded concurrent batches.
 *
 * Batches discovered paths into in-process metadata size jobs while the
 * directory walk is still running (bounded by SIZE_MAX_INFLIGHT), so sizes
 * stream in instead of waiting for traversal to finish. A batch that fails
 * for a non-budget reason re-sizes its entries with the stat fallback
 * inline; only a resource-limit failure fails the scan.
 */
/** @internal Exported for lifecycle regression tests; not a package API. */
export class ProgressiveSizer {
  private readonly pending: ScanEntry[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private readonly slots = new Semaphore(SIZE_MAX_INFLIGHT);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private stopped = false;
  private failure: unknown;
  /** Candidates already committed into `tracker`, so batch fallback never double-counts. */
  private readonly trackerRecorded = new Set<ScanEntry>();

  constructor(
    private readonly hooks: ScanHooks,
    signal?: AbortSignal,
    private readonly budget = new ResourceBudget({
      ...SCAN_RESOURCE_PROFILES[hooks.resourceProfile ?? "balanced"],
      ...hooks.limits,
    }),
    private readonly tracker?: HardlinkTracker,
  ) {
    this.signal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
  }

  private flushPending(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length > 0 && !this.stopped)
      this.launch(this.pending.splice(0, this.pending.length));
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.length = 0;
    this.controller.abort();
    await Promise.all(this.inflight);
  }

  /** Queue an entry as soon as it is discovered; launches a batch when one fills. */
  add(entry: ScanEntry): void {
    if (this.stopped || this.signal.aborted) return;
    this.pending.push(entry);
    const pendingPaths = this.pending.map((item) => item.path);
    if (
      this.pending.length >= SIZE_BATCH_SIZE ||
      batchPathCost(pendingPaths) >= SIZE_BATCH_PATH_BUDGET
    ) {
      this.flushPending();
    } else {
      this.timer ??= setTimeout(() => this.flushPending(), 16);
    }
  }

  /** Admit one bounded metadata batch without blocking the walk. */
  private launch(batch: ScanEntry[]): void {
    for (const entries of splitEntriesByPathBudget(batch)) {
      if (entries.length === 0) continue;
      const task = this.runBatch(entries);
      const tracked = task
        .catch(async (error: unknown) => {
          if (isFatalScanError(error) || this.hooks.waitForConsumer) {
            this.failure ??= error;
            this.controller.abort();
            return;
          }
          // A non-budget batch failure (a dying mount mid-job, a throwing
          // hook) must not sink the whole scan: size this batch's entries
          // with the per-entry stat fallback - the arm the dead `unsized`
          // list never reached. Entries already committed to `tracker` skip
          // re-recording so scan-wide hardlink counts are never inflated.
          for (const entry of entries) {
            if (this.signal.aborted) break;
            try {
              const useTracker =
                this.tracker && !this.trackerRecorded.has(entry) ? this.tracker : undefined;
              const size = await applyFallbackSizeAsync(
                entry,
                this.signal,
                this.budget,
                useTracker,
              );
              if (useTracker) this.trackerRecorded.add(entry);
              entry.estimatedBytes = size.bytes;
              entry.uniqueBytes = size.uniqueBytes;
              entry.bytesKnown = size.complete;
              this.hooks.onEntrySized?.(entry);
            } catch (fallbackError) {
              if (isFatalScanError(fallbackError)) {
                this.failure ??= fallbackError;
              }
              // A non-budget fallback failure leaves the entry unsized -
              // bytesKnown stays false and summary.exact demotes honestly.
            }
          }
        })
        .then(() => {
          this.inflight.delete(tracked);
        });
      this.inflight.add(tracked);
    }
  }

  private async runBatch(batch: ScanEntry[]): Promise<void> {
    await this.slots.acquire();
    try {
      if (this.signal?.aborted) return;
      await mapPool(batch, 2, async (entry) => {
        const useTracker =
          this.tracker && !this.trackerRecorded.has(entry) ? this.tracker : undefined;
        const size = await apparentSizeDetailed(entry.path, this.signal, this.budget, useTracker);
        if (useTracker) this.trackerRecorded.add(entry);
        entry.estimatedBytes = size.bytes;
        entry.uniqueBytes = size.uniqueBytes;
        entry.bytesKnown = size.complete;
        if (!this.signal.aborted) {
          this.hooks.onEntrySized?.(entry);
          const pendingOutput = this.hooks.waitForConsumer?.();
          if (pendingOutput) await pendingOutput;
        }
      });
    } finally {
      this.slots.release();
    }
  }

  /** Flush leftovers and surface any fatal failure; resolves when settled. */
  async finish(): Promise<void> {
    this.flushPending();
    await Promise.all(this.inflight);
    if (this.failure !== undefined) throw this.failure;
  }
}

// ─── Recursive scanner ────────────────────────────────────────────────────────

/**
 * Recursively scan targetDir for entries matching config.patterns.
 *
 * Emits `onEntry` during the walk (time-to-first-result). Metadata
 * sizing streams concurrently with traversal and
 * `onEntrySized` fires as each batch resolves.
 */
export async function scan(
  targetDir: string,
  config: SweepConfig,
  exact = false,
  hooks: ScanHooks = {},
): Promise<ScanResult> {
  const targetIdentity = readFilesystemIdentity(targetDir);
  hooks.onStarted?.(targetIdentity);
  const entries: ScanEntry[] = [];
  let scannedDirs = 0;
  let skippedDirs = 0;
  let sizedCount = 0;
  let progressAt = 0;
  let sizedProgressAt = 0;
  const emitProgress = (currentDir?: string, force = false) => {
    if (!hooks.onProgress) return;
    if (!force && scannedDirs !== 1 && scannedDirs - progressAt < 8) return;
    progressAt = scannedDirs;
    sizedProgressAt = sizedCount;
    hooks.onProgress({
      scannedDirs,
      found: entries.length,
      skippedDirs,
      sizedCount,
      ...(currentDir === undefined ? {} : { currentDir }),
    });
  };
  // Count completions once so progress events carry a real sized/found pair -
  // a queue-coverage meter cannot express "still working" honestly. Sized
  // events also force a heartbeat past the walk-end tail, when scannedDirs
  // stops advancing and cadence alone would go quiet (mirrors A09).
  const countingHooks: ScanHooks = {
    ...hooks,
    onEntrySized: (entry) => {
      sizedCount++;
      hooks.onEntrySized?.(entry);
      if (sizedCount - sizedProgressAt >= 16) emitProgress(undefined, true);
    },
  };
  const skipDir = () => {
    skippedDirs++;
    // A forced emit per skip used to write one --json-stream line per
    // unreadable dir - a skip flood buffered unboundedly at a slow consumer.
    // The regular cadence (plus the forced tail emit) still carries the count.
    emitProgress();
  };
  const matches = compileMatcher(config.patterns);
  // Compiled once per scan - the hot loop must not re-resolve paths per entry.
  const isIgnored = compileIgnoreMatcher(targetDir, config.ignore);
  const controller = new AbortController();
  const signal = hooks.signal
    ? AbortSignal.any([hooks.signal, controller.signal])
    : controller.signal;
  const budget = new ResourceBudget({
    ...SCAN_RESOURCE_PROFILES[hooks.resourceProfile ?? "balanced"],
    ...hooks.limits,
  });
  const hardlinks = new HardlinkTracker(budget.limits.maxIdentities, budget);
  // Reparse-point/junction detection is a Windows-only concern; Dirent already
  // reports symlinks authoritatively on POSIX platforms.
  const needsReparseCheck = platform === "win32";
  // Apparent metadata sizing streams during discovery. Exact mode sizes
  // after discovery using the same resource budget.
  const sizer = !exact ? new ProgressiveSizer(countingHooks, signal, budget, hardlinks) : null;

  type Frame = { dir: string; depth: number };

  /**
   * Visited directory inodes (`dev:ino`). A bind mount, loop-mounted subtree,
   * or a hardlinked dir can make the same filesystem object reachable under
   * multiple paths; without this the walk would visit it forever (depth=-1) or
   * duplicate work (depth=n). Windows reports ino=0, so dedupe only applies
   * where inodes are real - junctions there are already excluded as reparse
   * points.
   */
  const visitedDirs = new Set<string>();

  const markDir = async (dir: string): Promise<boolean> => {
    try {
      // bigint: a `number` inode already lost precision past 2^53 - wrapping
      // it in BigInt afterwards would not get it back (phase-3 A03 note).
      const stat = await lstat(dir, { bigint: true });
      // A dir swapped for a symlink between readdir and here would make
      // readdir follow it outside the target - refuse anything that is no
      // longer a real directory. (Narrows, not eliminates, the swap window.)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      if (stat.ino === 0n) return true; // no inode identity, cannot dedupe
      const key = `${stat.dev}:${stat.ino}`;
      if (visitedDirs.has(key)) return false;
      budget.identity();
      visitedDirs.add(key);
      return true;
    } catch (error) {
      if (isFatalScanError(error)) throw error;
      return false;
    }
  };

  async function scanDir(frame: Frame): Promise<void> {
    const { dir, depth } = frame;

    const items = directoryEntries(dir, budget, signal);
    let first: Awaited<ReturnType<typeof items.next>>;
    try {
      first = await items.next();
    } catch (error) {
      // An unreadable scan root must not silently produce an empty result -
      // that reads as "nothing to clean" when the truth is "couldn't look".
      if (depth === 0 || isFatalScanError(error)) throw error;
      skipDir();
      return;
    }

    scannedDirs++;
    emitProgress(relative(targetDir, dir) || ".");
    const childDepth = depth + 1;
    const childrenAllowed = config.depth === -1 || childDepth <= config.depth;

    // A reader error after the first batch (mid-listing ENOENT/EIO, a dying
    // NFS/FUSE mount) degrades this dir to skipped instead of failing the
    // whole scan - Rust parity: incomplete dir + skippedDirs increment.
    let midReadError = false;
    let dirEntriesSeen = 0;
    async function* openedEntries() {
      try {
        if (!first.done) yield first.value;
        while (true) {
          let next: Awaited<ReturnType<typeof items.next>>;
          try {
            next = await items.next();
          } catch (error) {
            if (isFatalScanError(error)) throw error;
            midReadError = true;
            return;
          }
          if (next.done) return;
          yield next.value;
        }
      } finally {
        await items.return(undefined);
      }
    }
    for await (const raw of openedEntries()) {
      const pendingOutput = hooks.waitForConsumer?.();
      if (pendingOutput) await pendingOutput;
      const item = {
        name: raw.name.toString("utf8"),
        isDirectory: () => raw.type === "d",
        isFile: () => raw.type === "f",
        isSymbolicLink: () => raw.type === "l",
      };
      budget.check();
      if (signal?.aborted) {
        return;
      }
      // A hostile or misbehaving directory (FUSE/NFS) can yield an unbounded
      // stream of dirents - bounded memory is not enough if the walk can be
      // spun forever. Cap entries seen per directory; past it the listing is
      // incomplete and the dir counts as skipped, like a mid-read error.
      if (++dirEntriesSeen > MAX_DIR_ENTRIES) {
        midReadError = true;
        break;
      }
      // Wire paths must round-trip to the exact dirent. A lossy UTF-8 name
      // can collide with a different real entry containing U+FFFD.
      if (item.name.includes("\ufffd") && !raw.name.equals(Buffer.from(item.name, "utf8"))) {
        midReadError = true;
        continue;
      }
      // A single giant directory emits no progress between dir boundaries -
      // heartbeat per 64k entries so a 4M-entry listing isn't a frozen UI.
      if (dirEntriesSeen % 65_536 === 0) {
        emitProgress(relative(targetDir, dir) || ".", true);
      }

      // Cheap name+type rejects first (Rust parity: cheap_reject ordering):
      // a non-matching leaf file/link can never be a candidate or a descent
      // target, and a non-matching dir only matters while depth allows
      // children. Skipping here avoids the path join, the ignore matcher
      // (which lowercases a relative path per entry), and - for "?" dirents
      // - the lstat, for the overwhelmingly common non-candidate.
      const mightMatch = matches(item.name);
      let isLink = item.isSymbolicLink();
      let rawIsDir = item.isDirectory();
      const typeKnown = isLink || rawIsDir || item.isFile();
      if (!mightMatch) {
        if (!childrenAllowed || skipDirName(item.name) || (typeKnown && !rawIsDir)) {
          continue;
        }
      }

      const fullPath = join(dir, item.name);

      if (isIgnored?.(fullPath, item.name)) continue;

      // DT_UNKNOWN filesystems (some NFSv3, CIFS/SMB, FUSE) report "?" for
      // every dirent - lstat is the only way to learn what it actually is.
      // Without this a real dir is silently never descended AND never
      // counted skipped - "found nothing" masquerading as "nothing there".
      if (!isLink && rawIsDir && needsReparseCheck) {
        isLink = isReparsePointOrSymlink(fullPath);
      }
      if (!typeKnown) {
        try {
          const stat = await lstat(fullPath);
          isLink = stat.isSymbolicLink();
          rawIsDir = stat.isDirectory();
        } catch {
          // Vanished or unlstatable - the listing is incomplete either way
          // (Rust parity: Err(item) / Err(file_type) mark it incomplete).
          midReadError = true;
          continue;
        }
      }

      if (mightMatch) {
        const { modifiedMs, identity } = await discoveryMetadata(fullPath);
        const entry: ScanEntry = {
          identity,
          path: fullPath,
          name: item.name,
          estimatedBytes: 0,
          bytesKnown: false,
          ...(modifiedMs !== undefined ? { modifiedMs } : {}),
          isSymlink: isLink,
          entryType: isLink ? "symlink" : rawIsDir ? "directory" : "file",
        };
        budget.candidate(fullPath, discoveryCandidateFieldChars(toCandidate(entry)));
        entries.push(entry);
        hooks.onEntry?.(entry);
        sizer?.add(entry);
        continue;
      }

      if (childrenAllowed && rawIsDir && !isLink && !skipDirName(item.name)) {
        // Already visited (bind mount / inode alias), or gone - either way
        // there is nothing to safely read under this path.
        if (await markDir(fullPath)) {
          pushDir({ dir: fullPath, depth: childDepth });
        } else {
          skipDir();
        }
      }
    }
    // A dir whose listing died partway is an incomplete read - count it as
    // skipped so the summary never reports "everything looked at" (F6).
    if (midReadError) skipDir();
  }

  // One shared work queue with a hard cap on in-flight directory reads - the
  // old per-directory mapPool let concurrency multiply by depth (A03). The
  // waiter list is a cursor over the queue plus a wake set, not Array.shift.
  const queue: Frame[] = [];
  let pending = 0;
  let scanError: unknown;
  let waiters: (() => void)[] = [];
  const wakeWaiters = () => {
    const woken = waiters;
    waiters = [];
    for (const resolve of woken) resolve();
  };
  const pushDir = (frame: Frame) => {
    budget.directory(frame.dir);
    queue.push(frame);
    pending++;
    wakeWaiters();
  };

  // A scan root that is a symlink (or not a dir at all) is refused before any
  // work is queued - markDir both classifies and registers the root inode.
  if (!(await markDir(targetDir))) {
    throw new Error(`target directory is not a real directory: ${targetDir}`);
  }
  pushDir({ dir: targetDir, depth: 0 });
  // An abort must wake workers parked on an empty queue or they hang forever.
  signal?.addEventListener("abort", wakeWaiters, { once: true });
  try {
    await Promise.all(
      Array.from({ length: TRAVERSAL_CONCURRENCY }, async () => {
        while (true) {
          while (queue.length > 0 && !signal?.aborted && scanError === undefined) {
            // LIFO favors depth-first locality and releases completed frames.
            const frame = queue.pop();
            if (frame === undefined) continue;
            budget.dequeueDirectory();
            try {
              await scanDir(frame);
            } catch (error) {
              // Keep the first failure; wake everyone so nothing waits on work
              // that will never arrive. Promise.all still resolves - the error
              // throws after the pool drains.
              scanError ??= error;
              controller.abort();
              pending--;
              wakeWaiters();
              return;
            }
            pending--;
            if (pending === 0) wakeWaiters();
          }
          if (pending === 0 || signal?.aborted || scanError !== undefined) return;
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      }),
    );
    if (scanError !== undefined) throw scanError;
    // An aborted walk leaves queued frames unvisited - count them skipped so
    // the result can never present a partial tree as a complete scan (F7).
    if (signal?.aborted && queue.length > 0) skippedDirs += queue.length;
    emitProgress(".", true);

    if (sizer) {
      await sizer.finish();
    } else {
      await applySizeEstimatesPostWalk(
        entries,
        exact,
        { ...countingHooks, signal },
        budget,
        hardlinks,
      );
    }
    // Terminal emit lands sizedCount == found so a meter drawn from progress
    // events only reaches 100% when sizing actually finished.
    emitProgress(".", true);

    const hasPartialCandidate = entries.some((e) => e.bytesKnown === false);
    const uniqueBytesPartial =
      hardlinks.isCapped() || (hasPartialCandidate && hardlinks.hasMultiLinkInodes());
    return {
      targetIdentity,
      entries,
      estimatedTotalBytes: entries.reduce((sum, e) => checkedBytes(sum, e.estimatedBytes), 0),
      uniqueTotalBytes: hardlinks.uniqueTotalBytes(),
      ...(uniqueBytesPartial ? { uniqueBytesPartial: true } : {}),
      scannedDirs,
      skippedDirs,
      // A partial candidate cannot support an exact byte claim.
      exact: exact && !hasPartialCandidate,
    };
  } finally {
    signal?.removeEventListener("abort", wakeWaiters);
    await sizer?.dispose();
    await disposeDirectoryReader(budget);
  }
}

/** Post-walk sizing for --exact mode and scans without streaming hooks. */
async function applySizeEstimatesPostWalk(
  entries: ScanEntry[],
  exact: boolean,
  hooks: ScanHooks,
  budget: ResourceBudget,
  tracker?: HardlinkTracker,
): Promise<void> {
  const signal = hooks.signal;

  await mapPool(entries, SIZE_CONCURRENCY, async (entry) => {
    if (signal?.aborted) return;
    const size = exact
      ? await exactSizeDetailed(entry.path, signal, budget, tracker)
      : await applyFallbackSizeAsync(entry, signal, budget, tracker);
    entry.estimatedBytes = size.bytes;
    entry.uniqueBytes = size.uniqueBytes;
    entry.bytesKnown = size.complete;
    hooks.onEntrySized?.(entry);
    const pendingOutput = hooks.waitForConsumer?.();
    if (pendingOutput) await pendingOutput;
  });
}
