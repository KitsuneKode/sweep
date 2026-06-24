#!/usr/bin/env bun
/**
 * Ensure committed parity golden plans use stable candidate ids.
 *
 * Usage:
 *   bun run scripts/validate-parity-goldens.ts
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import { stableCandidateId } from "../tests/support/normalize-plan.js";

const FIXTURES = resolve(import.meta.dir, "..", "tests/fixtures");

function main(): void {
  let checked = 0;

  for (const entry of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const planPath = join(FIXTURES, entry.name, "expected.plan.json");
    if (!existsSync(planPath)) {
      continue;
    }

    const plan = JSON.parse(readFileSync(planPath, "utf8")) as ScanPlan;
    for (const candidate of plan.candidates) {
      const expectedId = stableCandidateId(candidate.path, candidate.name);
      if (candidate.id !== expectedId) {
        console.error(
          `error: ${entry.name} candidate ${candidate.path} has id ${candidate.id}, expected ${expectedId}`,
        );
        console.error(
          "regenerate with: bun run scripts/generate-parity-fixture.ts -- tests/fixtures/" +
            entry.name,
        );
        process.exit(1);
      }
    }

    checked += 1;
  }

  console.log(`validated stable candidate ids in ${checked} parity golden fixture(s)`);
}

main();
