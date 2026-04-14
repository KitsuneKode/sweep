import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ScanEntry, ScanResult, SweepConfig } from "./types.js";

// ─── Pattern matching ─────────────────────────────────────────────────────────

/**
 * Test if a filename matches any of the given patterns.
 * Supports exact names ("node_modules") and simple globs ("*.tsbuildinfo").
 *
 * TODO: Consider replacing with `micromatch` for full glob semantics.
 * Current implementation covers all built-in default patterns correctly.
 */
function matchesPattern(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (!pattern.includes("*")) {
      return name === pattern;
    }
    // Simple glob: only handles leading/trailing * and *.ext style
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(name);
  });
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

      // Check symlink status via lstat (never follow links)
      let symlink = false;
      try {
        symlink = lstatSync(fullPath).isSymbolicLink();
      } catch {
        continue; // Can't stat — skip
      }

      if (matchesPattern(item.name, config.patterns)) {
        entries.push({
          path: fullPath,
          name: item.name,
          estimatedBytes: exact ? exactSize(fullPath) : estimateSize(fullPath),
          isSymlink: symlink,
        });
        // Critical: do NOT recurse into matched directories.
        // This prevents double-counting and infinite loops.
        continue;
      }

      // Recurse into non-matched, non-symlink directories
      if (item.isDirectory() && !symlink) {
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
