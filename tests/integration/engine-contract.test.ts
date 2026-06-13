import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "@kitsunekode/sweep-core/config";
import { scanToPlan } from "@kitsunekode/sweep-core/engine";
import {
  isRustEngineAvailable,
  resolveRustEngineBinary,
  scanToPlanViaRust,
} from "@kitsunekode/sweep-core/rust-engine";
import type { ScanPlan, SelectionPolicy } from "@kitsunekode/sweep-protocol";
import { normalizePlan } from "../support/normalize-plan.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const FIXTURES_ROOT = join(REPO_ROOT, "tests/fixtures");
const LOCAL_BINARY = join(REPO_ROOT, "target/debug/sweep-engine");

interface FixtureRequest {
  exact?: boolean;
  selectionPolicy?: SelectionPolicy;
}

function loadFixtureCases(): Array<{ name: string; root: string; request: FixtureRequest }> {
  return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const root = join(FIXTURES_ROOT, entry.name);
      const requestPath = join(root, "request.json");
      const expectedPath = join(root, "expected.plan.json");
      if (!existsSync(requestPath) || !existsSync(expectedPath)) {
        return null;
      }

      const request = JSON.parse(readFileSync(requestPath, "utf8")) as FixtureRequest;
      return { name: entry.name, root, request };
    })
    .filter((fixture): fixture is { name: string; root: string; request: FixtureRequest } =>
      Boolean(fixture),
    );
}

function assertMatchesGolden(actual: ScanPlan, fixtureRoot: string): void {
  const expectedPath = join(fixtureRoot, "expected.plan.json");
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as ScanPlan;
  expect(normalizePlan(actual, fixtureRoot)).toEqual(expected);
}

describe("engine contract fixtures", () => {
  const fixtures = loadFixtureCases();

  test("fixture catalog is non-empty", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    test(`js engine: ${fixture.name}`, () => {
      const options: { exact: boolean; selectionPolicy?: SelectionPolicy } = {
        exact: fixture.request.exact ?? false,
      };
      if (fixture.request.selectionPolicy) {
        options.selectionPolicy = fixture.request.selectionPolicy;
      }

      const { plan } = scanToPlan(fixture.root, DEFAULT_CONFIG, options);
      assertMatchesGolden(plan, fixture.root);
    });

    test(`rust engine: ${fixture.name}`, () => {
      if (process.env.SWEEP_ENGINE_FROM_NPM === "1") {
        return;
      }

      if (!existsSync(LOCAL_BINARY)) {
        return;
      }

      // Rust subprocess scan does not yet honor request.json options; fixtures must
      // use default scan settings until parity improves.
      expect(isRustEngineAvailable()).toBe(true);
      expect(resolveRustEngineBinary()).toBe(LOCAL_BINARY);

      const plan = scanToPlanViaRust(fixture.root);
      assertMatchesGolden(plan, fixture.root);
    });
  }
});
