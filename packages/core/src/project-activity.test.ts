import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatIdle, parseIdleDuration, ProjectActivityIndex } from "./project-activity.js";
import { restrictSelectionToIdle } from "./planner.js";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-26T12:00:00Z");
let root: string;
const at = (path: string, daysAgo: number) => {
  const when = new Date(NOW - daysAgo * DAY);
  utimesSync(path, when, when);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sweep-activity-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("project activity", () => {
  test("a rebuild does not make a project look active; editing its files does", () => {
    const project = join(root, "app");
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(join(project, "node_modules"));
    writeFileSync(join(project, "package.json"), "{}");
    at(join(project, "package.json"), 90);
    at(join(project, "src"), 120);
    at(join(project, "node_modules"), 0); // reinstalled today
    const activity = new ProjectActivityIndex(new Set([join(project, "node_modules")]), NOW);
    const result = activity.forArtifact(join(project, "node_modules"));
    expect(result.root).toBe(project);
    expect(Math.round((NOW - result.activeMs!) / DAY)).toBe(90);
  });

  test("git activity counts, and custom-pattern artifacts never do", () => {
    const project = join(root, "svc");
    mkdirSync(join(project, ".git", "logs"), { recursive: true });
    mkdirSync(join(project, ".output"));
    writeFileSync(join(project, "go.mod"), "module x");
    writeFileSync(join(project, ".git", "index"), "");
    at(join(project, "go.mod"), 200);
    at(join(project, ".git", "index"), 3);
    at(join(project, ".output"), 0);
    const activity = new ProjectActivityIndex(new Set([join(project, ".output")]), NOW);
    expect(Math.round((NOW - activity.forArtifact(join(project, ".output")).activeMs!) / DAY)).toBe(
      3,
    );
  });

  test("durations parse strictly and format compactly", () => {
    expect(parseIdleDuration("30d")).toBe(30 * DAY);
    expect(parseIdleDuration("2w")).toBe(14 * DAY);
    expect(parseIdleDuration("3m")).toBe(90 * DAY);
    expect(() => parseIdleDuration("30")).toThrow();
    expect(() => parseIdleDuration("-1d")).toThrow();
    expect(formatIdle(NOW - 5 * 3_600_000, NOW)).toBe("5h");
    expect(formatIdle(NOW - 12 * DAY, NOW)).toBe("12d");
    expect(formatIdle(NOW - 95 * DAY, NOW)).toBe("3mo");
  });
});

describe("--idle selection", () => {
  test("keeps idle projects selected, drops active and unknown ones", () => {
    const candidate = (id: string, projectActiveMs?: number) => ({
      id,
      path: `/w/${id}/node_modules`,
      name: "node_modules",
      kind: "node_modules",
      estimatedBytes: 1,
      isSymlink: false,
      entryType: "directory",
      riskTier: "safe",
      reasons: [],
      selectedByDefault: true,
      ...(projectActiveMs === undefined ? {} : { projectActiveMs }),
    });
    const plan = {
      candidates: [candidate("old", NOW - 60 * DAY), candidate("hot", NOW - DAY), candidate("unk")],
      selectedCandidateIds: ["old", "hot", "unk"],
      summary: { selectedCount: 3 },
    } as unknown as ScanPlan;
    const idle = restrictSelectionToIdle(plan, 30 * DAY, NOW);
    expect(idle.selectedCandidateIds).toEqual(["old"]);
    expect(idle.summary.selectedCount).toBe(1);
  });
});
