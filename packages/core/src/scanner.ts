import { execFile } from "node:child_process";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ScanEntry, ScanResult, SweepConfig } from "@kitsunekode/sweep-protocol";
import { mapPool } from "./async-pool.js";
import { isIgnoredEntry } from "./config.js";
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

// ─── Pattern matching ─────────────────────────────────────────────────────────

function compileMatcher(patterns: string[]): (name: string) => boolean {
  const exact = new Set<string>();
  const regexes: RegExp[] = [];

  for (const p of patterns) {
    if (!p.includes("*")) {
      exact.add(p);
    } else {
      const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      regexes.push(new RegExp(`^${escaped}$`));
    }
  }

  if (regexes.length === 0) return (name) => exact.has(name);
  return (name) => exact.has(name) || regexes.some((re) => re.test(name));
}

// ─── Size estimation ──────────────────────────────────────────────────────────

const platform = process.platform;
const DU_CHUNK_SIZE = 50;

async function batchEstimateAsync(paths: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (paths.length === 0 || (platform !== "linux" && platform !== "darwin")) {
    return result;
  }

  const flag = platform === "linux" ? "-sb" : "-sk";
  const multiplier = platform === "linux" ? 1 : 1024;

  for (let i = 0; i < paths.length; i += DU_CHUNK_SIZE) {
    const chunk = paths.slice(i, i + DU_CHUNK_SIZE);
    try {
      const { stdout } = await execFileAsync("du", [flag, ...chunk], {
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
      // Chunk failed — paths in this chunk will use statSync fallback
    }
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

/** Exact recursive size by walking all files under a path. */
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

async function applySizeEstimatesStreaming(
  entries: ScanEntry[],
  exact: boolean,
  hooks: ScanHooks,
): Promise<void> {
  const signal = hooks.signal;

  if (exact) {
    await mapPool(entries, SIZE_CONCURRENCY, async (entry) => {
      if (signal?.aborted) {
        return entry;
      }
      entry.estimatedBytes = exactSize(entry.path);
      hooks.onEntrySized?.(entry);
      return entry;
    });
    return;
  }

  const sizeMap = new Map<string, number>();
  const paths = entries.map((entry) => entry.path);

  for (let index = 0; index < paths.length; index += DU_CHUNK_SIZE) {
    if (signal?.aborted) {
      break;
    }
    const chunk = paths.slice(index, index + DU_CHUNK_SIZE);
    const chunkSizes = await batchEstimateAsync(chunk);
    for (const [path, bytes] of chunkSizes) {
      sizeMap.set(path, bytes);
    }
  }

  await mapPool(entries, SIZE_CONCURRENCY, async (entry) => {
    if (signal?.aborted) {
      return entry;
    }

    const fromDu = sizeMap.get(entry.path);
    if (fromDu !== undefined) {
      entry.estimatedBytes = fromDu;
    } else if (entry.entryType === "directory") {
      entry.estimatedBytes = exactSize(entry.path);
    } else {
      entry.estimatedBytes = statFallback(entry.path);
    }

    hooks.onEntrySized?.(entry);
    return entry;
  });
}

// ─── Recursive scanner ────────────────────────────────────────────────────────

/**
 * Recursively scan targetDir for entries matching config.patterns.
 *
 * Emits `onEntry` during the walk (time-to-first-result). Size estimation runs
 * concurrently per entry; `onEntrySized` fires as each size resolves.
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
  const signal = hooks.signal;

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

      if (isIgnoredEntry(targetDir, fullPath, item.name, config.ignore)) continue;

      let isLink = item.isSymbolicLink();
      if (!isLink && item.isDirectory()) {
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
  await applySizeEstimatesStreaming(entries, exact, hooks);

  return {
    entries,
    estimatedTotalBytes: entries.reduce((sum, e) => sum + e.estimatedBytes, 0),
    scannedDirs,
    exact,
  };
}
