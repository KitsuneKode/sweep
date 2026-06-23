#!/usr/bin/env bun
/**
 * Benchmark scan throughput on a generated large fixture tree.
 *
 * Usage: bun run packages/core/benchmarks/large-stream.ts
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { scan } from "../src/scanner.js";

const tmpDir = mkdtempSync("/tmp/sweep-bench-");
const appsDir = join(tmpDir, "apps");

for (let app = 0; app < 8; app++) {
  const appRoot = join(appsDir, `app-${app}`);
  for (let pkg = 0; pkg < 6; pkg++) {
    mkdirSync(join(appRoot, `pkg-${pkg}`, "node_modules"), { recursive: true });
    mkdirSync(join(appRoot, `pkg-${pkg}`, "dist"), { recursive: true });
  }
}

const started = performance.now();
let firstEntryMs: number | null = null;
let sizedCount = 0;

const result = await scan(tmpDir, { ...DEFAULT_CONFIG, depth: -1 }, false, {
  onEntry: () => {
    if (firstEntryMs === null) {
      firstEntryMs = performance.now() - started;
    }
  },
  onEntrySized: () => {
    sizedCount += 1;
  },
});

const elapsed = performance.now() - started;
rmSync(tmpDir, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      candidates: result.entries.length,
      scannedDirs: result.scannedDirs,
      firstEntryMs,
      sizedCount,
      totalMs: Math.round(elapsed),
      estimatedTotalBytes: result.estimatedTotalBytes,
    },
    null,
    2,
  ),
);
