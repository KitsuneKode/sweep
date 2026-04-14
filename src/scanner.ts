import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ScanEntry, ScanResult, SweepConfig } from "./types.js";

// ─── Pattern matching ─────────────────────────────────────────────────────────

/**
 * Pre-compile a pattern list into a fast matcher function.
 *
 * Exact patterns use a Set for O(1) lookup.
 * Glob patterns ("*.tsbuildinfo") are compiled to RegExp once, not per entry.
 *
 * Called once per scan, not per directory entry.
 */
function compileMatcher(patterns: string[]): (name: string) => boolean {
  const exact = new Set<string>();
  const regexes: RegExp[] = [];

  for (const p of patterns) {
    if (!p.includes("*")) {
      exact.add(p);
    } else {
      // Simple glob → regex: only *.ext style is supported (covers all default patterns)
      const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      regexes.push(new RegExp(`^${escaped}$`));
    }
  }

  if (regexes.length === 0) return (name) => exact.has(name);
  return (name) => exact.has(name) || regexes.some((re) => re.test(name));
}

/**
 * Test if an absolute path should be skipped due to ignore rules.
 * Ignore entries are matched as substrings of the full path.
 */
function shouldIgnore(fullPath: string, ignore: string[]): boolean {
  return ignore.some((pattern) => fullPath.includes(pattern));
}

// ─── Size estimation ──────────────────────────────────────────────────────────

const platform = process.platform;

// Max paths per du invocation — stays well under ARG_MAX on all platforms.
const DU_CHUNK_SIZE = 50;

/**
 * Batch size estimate for multiple paths via a single `du` invocation per chunk.
 *
 * Drastically faster than one subprocess per entry: a monorepo with 20
 * node_modules goes from 20 process spawns down to 1.
 *
 * Returns a Map<path, bytes>. Paths not in the map fell back to statSync.
 *
 * - Linux:   `du -sb paths...`  → bytes (GNU du)
 * - macOS:   `du -sk paths...`  → kilobytes (BSD du, no -b flag)
 * - Other:   skipped — callers use statSync fallback
 */
function batchEstimate(paths: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (paths.length === 0 || (platform !== "linux" && platform !== "darwin")) {
    return result;
  }

  const flag = platform === "linux" ? "-sb" : "-sk";
  const multiplier = platform === "linux" ? 1 : 1024;

  // Process in chunks to stay under ARG_MAX
  for (let i = 0; i < paths.length; i += DU_CHUNK_SIZE) {
    const chunk = paths.slice(i, i + DU_CHUNK_SIZE);
    try {
      const out = execFileSync("du", [flag, ...chunk], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "ignore"],
      });

      for (const line of out.split("\n")) {
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

/** Fallback size for a single path when du is unavailable or fails. */
function statFallback(entryPath: string): number {
  try {
    return statSync(entryPath).size;
  } catch {
    return 0;
  }
}

/**
 * Exact recursive size by walking all files under a path.
 * Slow on large node_modules — only called for --dry-run.
 */
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
      if (item.isSymbolicLink()) continue; // don't follow links
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

// ─── Recursive scanner ────────────────────────────────────────────────────────

/**
 * Recursively scan targetDir for entries matching config.patterns.
 *
 * Key behaviors:
 * - Does NOT recurse into matched directories (avoids double-counting)
 * - Does NOT follow symlinks (marks them as isSymlink: true, doesn't recurse)
 * - Skips entries in config.ignore
 * - Respects config.depth (-1 = unlimited)
 * - Fast path: sizes estimated via a single batched `du` call after the walk
 * - Exact path (--dry-run): recursive stat walk per entry
 */
export function scan(targetDir: string, config: SweepConfig, exact = false): ScanResult {
  const entries: ScanEntry[] = [];
  let scannedDirs = 0;

  // Compile patterns once — O(1) Set lookup for exact names, pre-built regexes for globs.
  const matches = compileMatcher(config.patterns);

  // ── Walk ────────────────────────────────────────────────────────────────────

  function walk(dir: string, depth: number): void {
    if (config.depth !== -1 && depth > config.depth) return;

    let items: import("node:fs").Dirent<string>[];
    try {
      items = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      // Permission denied or other FS error — skip silently
      return;
    }

    scannedDirs++;

    for (const item of items) {
      const fullPath = join(dir, item.name);

      if (shouldIgnore(fullPath, config.ignore)) continue;

      // item.isSymbolicLink() from readdirSync is accurate on modern Linux/macOS
      // (getdents64 d_type includes link info). On exotic filesystems (DT_UNKNOWN),
      // all type methods return false — fall back to lstatSync only then.
      // Safety: a symlink deleted via rmSync({recursive}) follows the link and
      // destroys the real directory, so we must never misclassify a symlink.
      let isLink = item.isSymbolicLink();
      if (!isLink && !item.isFile() && !item.isDirectory()) {
        // DT_UNKNOWN — fall back to lstat
        try {
          isLink = lstatSync(fullPath).isSymbolicLink();
        } catch {
          continue; // can't stat — skip
        }
      }

      if (matches(item.name)) {
        entries.push({
          path: fullPath,
          name: item.name,
          estimatedBytes: 0, // filled below
          isSymlink: isLink,
        });
        // Critical: do NOT recurse into matched directories.
        // This prevents double-counting and infinite loops.
        continue;
      }

      // Recurse into non-matched, non-symlink directories
      if (item.isDirectory() && !isLink) {
        walk(fullPath, depth + 1);
      }
    }
  }

  walk(targetDir, 0);

  // ── Size estimation ─────────────────────────────────────────────────────────

  if (exact) {
    // Exact mode: recursive stat walk per entry (slow but accurate, used for --dry-run)
    for (const entry of entries) {
      entry.estimatedBytes = exactSize(entry.path);
    }
  } else {
    // Fast mode: single batched du call for all entries, then fill gaps with statSync
    const sizeMap = batchEstimate(entries.map((e) => e.path));
    for (const entry of entries) {
      entry.estimatedBytes = sizeMap.get(entry.path) ?? statFallback(entry.path);
    }
  }

  return {
    entries,
    estimatedTotalBytes: entries.reduce((sum, e) => sum + e.estimatedBytes, 0),
    scannedDirs,
    exact,
  };
}
