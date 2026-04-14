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

/**
 * Fast size estimate via `du`.
 *
 * - Linux:   `du -sb <path>`  → bytes (GNU du)
 * - macOS:   `du -sk <path>`  → kilobytes (BSD du, no -b flag)
 * - Windows: not supported — falls back to statSync
 * - Any error: falls back to statSync (directory entry size, ~4 KB, inaccurate)
 *
 * For --dry-run exact sizes, use exactSize() instead.
 */
function estimateSize(entryPath: string): number {
  try {
    if (platform === "linux") {
      const out = execFileSync("du", ["-sb", entryPath], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const bytes = Number.parseInt(out.split("\t")[0] ?? "0", 10);
      return Number.isNaN(bytes) ? 0 : bytes;
    }

    if (platform === "darwin") {
      const out = execFileSync("du", ["-sk", entryPath], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const kb = Number.parseInt(out.split("\t")[0] ?? "0", 10);
      return Number.isNaN(kb) ? 0 : kb * 1024;
    }
  } catch {
    // Fall through to statSync
  }

  // Fallback: directory entry size — inaccurate but safe
  try {
    return statSync(entryPath).size;
  } catch {
    return 0;
  }
}

/**
 * Exact recursive size by walking all files under a path.
 * Slow on large node_modules — only call this for --dry-run.
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
 */
export function scan(targetDir: string, config: SweepConfig, exact = false): ScanResult {
  const entries: ScanEntry[] = [];
  let scannedDirs = 0;

  // Compile patterns once — O(1) exact lookups + pre-built regexes for globs.
  // This avoids rebuilding regexes for every directory entry (can be thousands).
  const matches = compileMatcher(config.patterns);

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
      // all type methods return false — we fall back to lstatSync only then.
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
          estimatedBytes: exact ? exactSize(fullPath) : estimateSize(fullPath),
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

  return {
    entries,
    estimatedTotalBytes: entries.reduce((sum, e) => sum + e.estimatedBytes, 0),
    scannedDirs,
    exact,
  };
}
