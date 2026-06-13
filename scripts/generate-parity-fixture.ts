#!/usr/bin/env bun
/**
 * Regenerate golden ScanPlan JSON for a parity fixture directory.
 *
 * Usage:
 *   bun run scripts/generate-parity-fixture.ts -- tests/fixtures/node_modules-only
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scanToPlan } from "@kitsunekode/sweep-core/engine";
import { DEFAULT_CONFIG } from "@kitsunekode/sweep-core/config";
import { normalizePlan } from "../tests/support/normalize-plan.js";

const DEFAULT_REQUEST = {
  exact: false,
  selectionPolicy: {
    mode: "default",
    includeDangerous: false,
  },
};

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
  const requestPath = join(fixtureRoot, "request.json");

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  if (!existsSync(requestPath)) {
    writeFileSync(requestPath, `${JSON.stringify(DEFAULT_REQUEST, null, 2)}\n`, "utf8");
    console.log(`wrote ${requestPath}`);
  }
  console.log(`wrote ${outPath}`);
}

main();
