import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { cleanupSeededFixtures, seedScenario } from "./support/fixtures.js";

afterEach(() => {
  cleanupSeededFixtures();
});

describe("seed fixture script", () => {
  test("creates a monorepo scenario in tmp and reports its root", () => {
    const report = seedScenario("monorepo");

    expect(report.scenario).toBe("monorepo");
    expect(existsSync(join(report.root, "packages", "web", "node_modules"))).toBe(true);
    expect(report.created.length).toBeGreaterThan(0);
  });

  test("creates a mixed-risk scenario with a symlink and custom artifact", () => {
    const report = seedScenario("risk-mix");

    expect(report.scenario).toBe("risk-mix");
    expect(existsSync(join(report.root, "node_modules"))).toBe(true);
    expect(existsSync(join(report.root, "custom-cache"))).toBe(true);
    expect(lstatSync(join(report.root, "linked-dist")).isSymbolicLink()).toBe(true);
  });

  test("creates a workspace-matrix scenario with multiple project artifact types", () => {
    const report = seedScenario("workspace-matrix");

    expect(report.scenario).toBe("workspace-matrix");
    expect(existsSync(join(report.root, "packages", "web", "node_modules"))).toBe(true);
    expect(existsSync(join(report.root, "packages", "api", "target"))).toBe(true);
    expect(existsSync(join(report.root, "apps", "docs", ".next"))).toBe(true);
    expect(existsSync(join(report.root, "apps", "docs", "custom-cache"))).toBe(true);
  });

  test("creates a large-plan scenario with many generated candidates", () => {
    const report = seedScenario("large-plan");

    expect(report.scenario).toBe("large-plan");
    expect(report.created.length).toBeGreaterThan(10);
    expect(existsSync(join(report.root, "packages", "pkg-0", "node_modules"))).toBe(true);
    expect(existsSync(join(report.root, "packages", "pkg-5", "dist"))).toBe(true);
  });

  test("creates a blocked-target scenario with a suggested guardrail target", () => {
    const report = seedScenario("blocked-target");

    expect(report.scenario).toBe("blocked-target");
    expect(report.guardrailTarget).toBe("/tmp");
  });
});
