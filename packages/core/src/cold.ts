/**
 * Cold-start controls for dev runs and benchmarks - `SWEEP_COLD=1` or the
 * CLI's `--cold` flag.
 *
 * What cold honestly covers in-process:
 * - the engine-availability probe memo (a fresh `sweep-engine --version`
 *   spawn per resolution instead of a memoized answer)
 * - OS page cache, but only when the process may write
 *   `/proc/sys/vm/drop_caches` (root). Without privilege the drop is
 *   reported, not pretended.
 *
 * What cold cannot cover from inside a running process:
 * - JIT/module warmth - only a fresh process gives that; the bench harness
 *   measures startup separately.
 * - page cache for unprivileged users - reported in the drop report.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const COLD_ENV = "SWEEP_COLD";
const DROP_CACHES_PATH = "/proc/sys/vm/drop_caches";

/** True when `SWEEP_COLD` is set to anything except an explicit off value. */
export function isColdRequested(): boolean {
  const value = process.env[COLD_ENV]?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

export interface ColdDropReport {
  /** True only when the kernel confirmed nothing remains cached. */
  dropped: boolean;
  /** Human-readable outcome - for `note:`/`warning:` lines on stderr. */
  detail: string;
}

/**
 * Flush dirty pages, then ask the kernel to drop clean page/dentry/inode
 * caches. Linux-only and root-only: sync converts dirty pages to clean so
 * the drop is real, and drop_caches rejects non-root writers. The write is
 * attempted, never sudo'd around - an undroppable cache reports honestly so
 * cold numbers are never silently warm.
 */
export function tryDropPageCache(): ColdDropReport {
  if (process.platform !== "linux") {
    return { dropped: false, detail: `no unprivileged cache drop on ${process.platform}` };
  }
  if (typeof process.geteuid !== "function" || process.geteuid() !== 0) {
    return { dropped: false, detail: "dropping page cache requires root" };
  }
  // Sync first: dirty pages are never dropped, so without it the drop leaves
  // a partially-warm cache that would still skew cold numbers.
  const sync = spawnSync("sync", { timeout: 10_000, stdio: "ignore" });
  if (sync.error !== undefined || sync.status !== 0) {
    return { dropped: false, detail: "sync failed - dirty pages would stay cached" };
  }
  try {
    writeFileSync(DROP_CACHES_PATH, "3\n");
    return { dropped: true, detail: "page cache dropped" };
  } catch (error) {
    return {
      dropped: false,
      detail: `drop_caches write failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
