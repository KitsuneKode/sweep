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
import { DEFAULT_SELECTION_POLICY } from "@kitsunekode/sweep-protocol";
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

function rustAvailable(): boolean {
  return process.env.SWEEP_ENGINE_FROM_NPM !== "1" && existsSync(LOCAL_BINARY);
}

function assertMatchesGolden(actual: ScanPlan, fixtureRoot: string): void {
  const expectedPath = join(fixtureRoot, "expected.plan.json");
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as ScanPlan;
  expect(normalizePlan(actual, fixtureRoot)).toEqual(expected);
}

function assertByteParity(jsPlan: ScanPlan, rustPlan: ScanPlan): void {
  const jsByPath = new Map(jsPlan.candidates.map((candidate) => [candidate.path, candidate]));
  expect(rustPlan.candidates.length).toBe(jsPlan.candidates.length);

  for (const rustCandidate of rustPlan.candidates) {
    const jsCandidate = jsByPath.get(rustCandidate.path);
    expect(jsCandidate).toBeDefined();
    const jsBytes = jsCandidate?.estimatedBytes ?? 0;
    const rustBytes = rustCandidate.estimatedBytes;
    const tolerance = Math.max(512, jsBytes * 0.15);
    expect(Math.abs(rustBytes - jsBytes)).toBeLessThanOrEqual(tolerance);
  }
}

function assertValidCreatedAt(plan: ScanPlan): void {
  expect(plan.createdAt).not.toBe("1970-01-01T00:00:00.000Z");
  expect(Number.isNaN(Date.parse(plan.createdAt))).toBe(false);
}

describe("engine contract fixtures", () => {
  const fixtures = loadFixtureCases();

  test("fixture catalog is non-empty", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    test(`js engine: ${fixture.name}`, async () => {
      const options: { exact: boolean; selectionPolicy?: SelectionPolicy } = {
        exact: fixture.request.exact ?? false,
      };
      if (fixture.request.selectionPolicy) {
        options.selectionPolicy = fixture.request.selectionPolicy;
      }

      const { plan } = await scanToPlan(fixture.root, DEFAULT_CONFIG, options);
      assertMatchesGolden(plan, fixture.root);
    });

    test(`rust engine: ${fixture.name}`, () => {
      if (!rustAvailable()) {
        return;
      }

      expect(isRustEngineAvailable()).toBe(true);
      expect(resolveRustEngineBinary()).toBe(LOCAL_BINARY);

      const plan = scanToPlanViaRust(fixture.root, {
        config: DEFAULT_CONFIG,
        selectionPolicy: fixture.request.selectionPolicy ?? DEFAULT_SELECTION_POLICY,
        exact: fixture.request.exact ?? false,
      });
      assertMatchesGolden(plan, fixture.root);
      assertValidCreatedAt(plan);
    });
  }

  for (const fixture of fixtures) {
    test(`js and rust byte estimates stay within tolerance: ${fixture.name}`, async () => {
      if (!rustAvailable()) {
        return;
      }

      const options = {
        exact: fixture.request.exact ?? false,
        selectionPolicy: fixture.request.selectionPolicy ?? DEFAULT_SELECTION_POLICY,
      };

      const { plan: jsPlan } = await scanToPlan(fixture.root, DEFAULT_CONFIG, options);
      const rustPlan = scanToPlanViaRust(fixture.root, {
        config: DEFAULT_CONFIG,
        ...options,
      });

      assertByteParity(jsPlan, rustPlan);
    });
  }

  test("rust engine rejects shallow guardrail targets", () => {
    if (!rustAvailable()) {
      return;
    }

    expect(() =>
      scanToPlanViaRust("/tmp", {
        config: DEFAULT_CONFIG,
        selectionPolicy: DEFAULT_SELECTION_POLICY,
      }),
    ).toThrow();
  });

  test("rust progressive hooks emit candidates before sizing completes", () => {
    if (!rustAvailable()) {
      return;
    }

    const basicFixture = fixtures.find((fixture) => fixture.name === "basic");
    if (!basicFixture) {
      return;
    }

    const order: string[] = [];
    scanToPlanViaRust(basicFixture.root, {
      config: DEFAULT_CONFIG,
      selectionPolicy: DEFAULT_SELECTION_POLICY,
      onEntry: () => {
        order.push("entry");
      },
      onEntrySized: () => {
        order.push("sized");
      },
    });

    expect(order.length).toBeGreaterThan(0);
    expect(order.indexOf("entry")).toBeLessThan(order.indexOf("sized"));
  });

  test("rust exact sizing marks plan summary as exact", () => {
    if (!rustAvailable()) {
      return;
    }

    const basicFixture = fixtures.find((fixture) => fixture.name === "basic");
    if (!basicFixture) {
      return;
    }

    const plan = scanToPlanViaRust(basicFixture.root, {
      config: DEFAULT_CONFIG,
      selectionPolicy: DEFAULT_SELECTION_POLICY,
      exact: true,
    });

    expect(plan.summary.exact).toBe(true);
  });
});
