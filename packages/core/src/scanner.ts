import { execFile } from "node:child_process";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ScanEntry, ScanResult, SweepConfig } from "@kitsunekode/sweep-protocol";
import { mapPool } from "./async-pool.js";
import { compileIgnoreMatcher } from "./config.js";
import { isReparsePointOrSymlink } from "./guardrails.js";

const execFileAsync = promisify(execFile);

export interface ScanHooks {
  /** Fired as soon as a matching entry is discovered (bytes may be 0 until sized). */
  onEntry?: (entry: ScanEntry) => void;
  /** Fired after size estimation completes for an entry. */
  onEntrySized?: (entry: ScanEntry) => void;
  /** Optional cancellation signal for long-running scans. */
  signal?: AbortSignal;
}

/** VCS/metadata dirs — never descend (major win on large trees). */
const SKIP_DIR_NAMES = new Set([".git", ".svn", ".hg", ".bzr"]);

const TRAVERSAL_CONCURRENCY = 16;
const SIZE_CONCURRENCY = 8;
/** Max du subprocesses in flight at once while the walk continues. */
const DU_MAX_INFLIGHT = 4;

// ─── Pattern matching ─────────────────────────────────────────────────────────

function compileMatcher(patterns: string[]): (name: string) => boolean {
  const isCaseInsensitive = process.platform === "darwin" || process.platform === "win32";
  const exact = new Set<string>(
    patterns.filter((p) => !p.includes("*")).map((p) => (isCaseInsensitive ? p.toLowerCase() : p)),
  );
  const regexes: RegExp[] = [];

  for (const p of patterns) {
    if (p.includes("*")) {
      const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      regexes.push(new RegExp(`^${escaped}$`, isCaseInsensitive ? "i" : undefined));
    }
  }

  if (regexes.length === 0) {
    return (name) => exact.has(isCaseInsensitive ? name.toLowerCase() : name);
  }
  return (name) => {
    const key = isCaseInsensitive ? name.toLowerCase() : name;
    return exact.has(key) || regexes.some((re) => re.test(name));
  };
}

// ─── Size estimation ──────────────────────────────────────────────────────────

const platform = process.platform;
const DU_CHUNK_SIZE = 50;

/** Size one batch (≤ DU_CHUNK_SIZE paths) via a single du subprocess. */
async function batchEstimateAsync(paths: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (paths.length === 0 || (platform !== "linux" && platform !== "darwin")) {
    return result;
  }

  const flag = platform === "linux" ? "-sb" : "-sk";
  const multiplier = platform === "linux" ? 1 : 1024;

  try {
    const { stdout } = await execFileAsync("du", [flag, ...paths], {
      timeout: 30_000,
      encoding: "utf8",
    });

    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const raw = Number.parseInt(line.slice(0, tab), 10);
      const path = line.slice(tab + 1);
      if (!Number.isNaN(raw)) {
        result.set(path, raw * multiplier);
      }
    }
  } catch {
    // Batch failed — paths land in the caller's fallback path
  }

  return result;
}

function statFallback(entryPath: string): number {
  try {
    return statSync(entryPath).size;
  } catch {
    return 0;
  }
}

/** Exact recursive size by walking all files under a path. Synchronous — opt-in exact mode and rare du fallbacks only. */
export function exactSize(entryPath: string): number {
  let total = 0;

  function walk(p: string): void {
    let items: import("node:fs").Dirent<string>[];
    try {
      items = readdirSync(p, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const item of items) {
      const full = join(p, item.name);
      if (item.isSymbolicLink()) continue;
      if (process.platform === "win32" && isReparsePointOrSymlink(full)) continue;
      if (item.isDirectory()) {
        walk(full);
      } else {
        try {
          total += statSync(full).size;
        } catch {
          // skip
        }
      }
    }
  }

  try {
    const st = lstatSync(entryPath);
    if (st.isSymbolicLink()) return st.size;
    if (st.isFile()) return st.size;
  } catch {
    return 0;
  }

  walk(entryPath);
  return total;
}

function applyFallbackSize(entry: ScanEntry): number {
  return entry.entryType === "directory" ? exactSize(entry.path) : statFallback(entry.path);
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
 * Streaming size estimator for du-backed platforms.
 *
 * Batches discovered paths into du subprocess calls while the directory walk
 * is still running (bounded by DU_MAX_INFLIGHT), so sizes stream in instead of
 * waiting for traversal to finish. Entries du could not size fall back to
 * exact/stat walks after all batches settle.
 */
class ProgressiveSizer {
  private readonly pending: ScanEntry[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private readonly unsized: ScanEntry[] = [];
  private readonly slots = new Semaphore(DU_MAX_INFLIGHT);

  constructor(
    private readonly hooks: ScanHooks,
    private readonly signal?: AbortSignal,
  ) {}

  /** Queue an entry as soon as it is discovered; launches a batch when one fills. */
  add(entry: ScanEntry): void {
    this.pending.push(entry);
    if (this.pending.length >= DU_CHUNK_SIZE) {
      this.launch(this.pending.splice(0, DU_CHUNK_SIZE));
    }
  }

  /** Spawn one bounded du batch without blocking the walk. */
  private launch(batch: ScanEntry[]): void {
    const task = this.runBatch(batch);
    const tracked = task.then(() => {
      this.inflight.delete(tracked);
    });
    this.inflight.add(tracked);
  }

  private async runBatch(batch: ScanEntry[]): Promise<void> {
    await this.slots.acquire();
    try {
      if (this.signal?.aborted) return;
      const sizes = await batchEstimateAsync(batch.map((entry) => entry.path));
      for (const entry of batch) {
        const bytes = sizes.get(entry.path);
        if (bytes !== undefined) {
          entry.estimatedBytes = bytes;
          this.hooks.onEntrySized?.(entry);
        } else {
          this.unsized.push(entry);
        }
      }
    } finally {
      this.slots.release();
    }
  }

  /** Flush leftovers and apply fallbacks; resolves when every entry is sized. */
  async finish(): Promise<void> {
    if (this.pending.length > 0) {
      this.launch(this.pending.splice(0, this.pending.length));
    }
    await Promise.all(this.inflight);

    const remaining = [...this.unsized];
    this.unsized.length = 0;
    await mapPool(remaining, SIZE_CONCURRENCY, async (entry) => {
      if (this.signal?.aborted) return;
      entry.estimatedBytes = applyFallbackSize(entry);
      this.hooks.onEntrySized?.(entry);
    });
  }
}

// ─── Recursive scanner ────────────────────────────────────────────────────────

/**
 * Recursively scan targetDir for entries matching config.patterns.
 *
 * Emits `onEntry` during the walk (time-to-first-result). On du-backed
 * platforms size estimation streams concurrently with traversal and
 * `onEntrySized` fires as each batch resolves.
 */
export async function scan(
  targetDir: string,
  config: SweepConfig,
  exact = false,
  hooks: ScanHooks = {},
): Promise<ScanResult> {
  const entries: ScanEntry[] = [];
  let scannedDirs = 0;
  const matches = compileMatcher(config.patterns);
  // Compiled once per scan — the hot loop must not re-resolve paths per entry.
  const isIgnored = compileIgnoreMatcher(targetDir, config.ignore);
  const signal = hooks.signal;
  // Reparse-point/junction detection is a Windows-only concern; Dirent already
  // reports symlinks authoritatively on POSIX platforms.
  const needsReparseCheck = platform === "win32";
  // du-backed platforms size entries progressively during the walk; other
  // platforms and --exact mode fall back to post-walk estimation.
  const sizer =
    !exact && (platform === "linux" || platform === "darwin")
      ? new ProgressiveSizer(hooks, signal)
      : null;

  type Frame = { dir: string; depth: number };

  async function walkDir(frame: Frame): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    const { dir, depth } = frame;
    if (config.depth !== -1 && depth > config.depth) {
      return;
    }

    let items: import("node:fs").Dirent<string>[];
    try {
      items = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    scannedDirs++;
    const childDirs: Frame[] = [];

    for (const item of items) {
      if (signal?.aborted) {
        return;
      }

      const fullPath = join(dir, item.name);

      if (isIgnored?.(fullPath, item.name)) continue;

      let isLink = item.isSymbolicLink();
      if (!isLink && item.isDirectory() && needsReparseCheck) {
        isLink = isReparsePointOrSymlink(fullPath);
      }
      if (!isLink && !item.isFile() && !item.isDirectory()) {
        try {
          const stat = await lstat(fullPath);
          isLink = stat.isSymbolicLink();
        } catch {
          continue;
        }
      }

      if (matches(item.name)) {
        const entry: ScanEntry = {
          path: fullPath,
          name: item.name,
          estimatedBytes: 0,
          isSymlink: isLink,
          entryType: isLink ? "symlink" : item.isDirectory() ? "directory" : "file",
        };
        entries.push(entry);
        hooks.onEntry?.(entry);
        sizer?.add(entry);
        continue;
      }

      if (item.isDirectory() && !isLink && !SKIP_DIR_NAMES.has(item.name)) {
        childDirs.push({ dir: fullPath, depth: depth + 1 });
      }
    }

    if (childDirs.length > 0) {
      await mapPool(childDirs, TRAVERSAL_CONCURRENCY, (child) => walkDir(child));
    }
  }

  await walkDir({ dir: targetDir, depth: 0 });

  if (sizer) {
    await sizer.finish();
  } else {
    await applySizeEstimatesPostWalk(entries, exact, hooks);
  }

  return {
    entries,
    estimatedTotalBytes: entries.reduce((sum, e) => sum + e.estimatedBytes, 0),
    scannedDirs,
    exact,
  };
}

/** Post-walk sizing for --exact mode and platforms without du. */
async function applySizeEstimatesPostWalk(
  entries: ScanEntry[],
  exact: boolean,
  hooks: ScanHooks,
): Promise<void> {
  const signal = hooks.signal;

  await mapPool(entries, SIZE_CONCURRENCY, async (entry) => {
    if (signal?.aborted) return;
    entry.estimatedBytes = exact ? exactSize(entry.path) : applyFallbackSize(entry);
    hooks.onEntrySized?.(entry);
  });
}
