import { availableParallelism } from "node:os";

/** Async I/O admission limits, not a count of JavaScript execution threads. */
export function scanConcurrencyFor(allowance: number) {
  const cpus = Number.isFinite(allowance) && allowance >= 1 ? Math.floor(allowance) : 1;
  return {
    traversal: Math.min(16, cpus * 2),
    sizingBatches: Math.min(4, Math.max(1, Math.floor(cpus / 2))),
    metadata: Math.min(8, cpus * 2),
  };
}

export const SCAN_CONCURRENCY = scanConcurrencyFor(availableParallelism());
