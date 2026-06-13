#!/usr/bin/env bun
/**
 * Regenerate golden ScanPlan JSON for a parity fixture directory.
 *
 * Usage:
 *   bun run scripts/generate-parity-fixture.ts -- tests/fixtures/node_modules-only
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scanToPlan } from "@kitsunekode/sweep-core/engine";
import { DEFAULT_CONFIG } from "@kitsunekode/sweep-core/config";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";

const PLACEHOLDER = "__FIXTURE_ROOT__";

function normalizePlan(plan: ScanPlan, fixtureRoot: string): ScanPlan {
  const replaceRoot = (value: string) =>
    value.startsWith(fixtureRoot) ? value.replace(fixtureRoot, PLACEHOLDER) : value;

  return {
    ...plan,
    targetDir: PLACEHOLDER,
    createdAt: "1970-01-01T00:00:00.000Z",
    candidates: plan.candidates.map((candidate) => ({
      ...candidate,
      path: replaceRoot(candidate.path),
      estimatedBytes: 0,
    })),
    summary: {
      ...plan.summary,
      estimatedTotalBytes: 0,
    },
  };
}

function main(): void {
  const fixtureArg = process.argv[2];
  if (!fixtureArg) {
    console.error("usage: bun run scripts/generate-parity-fixture.ts -- <fixture-dir>");
    process.exit(1);
  }

  const fixtureRoot = resolve(fixtureArg);
  const { plan } = scanToPlan(fixtureRoot, DEFAULT_CONFIG);
  const normalized = normalizePlan(plan, fixtureRoot);
  const outPath = join(fixtureRoot, "expected.plan.json");

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  console.log(`wrote ${outPath}`);
}

main();
