import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
    expect(result.confidence).toBe("proven");
    expect(Math.round((NOW - result.activeMs!) / DAY)).toBe(90);
  });

  test("in-place edits to nested source files keep the project active even when top-level dirs are old", () => {
    const project = join(root, "nested-app");
    const deepDir = join(project, "src", "components", "forms");
    mkdirSync(deepDir, { recursive: true });
    mkdirSync(join(project, "node_modules"));
    writeFileSync(join(project, "package.json"), "{}");
    const editedFile = join(deepDir, "Login.tsx");
    writeFileSync(editedFile, "export const Login = () => null;");

    // Simulate editing Login.tsx in-place without bumping parent directory mtimes.
    at(join(project, "package.json"), 90);
    at(join(project, "src"), 90);
    at(join(project, "src", "components"), 90);
    at(deepDir, 90);
    at(editedFile, 2);
    at(join(project, "node_modules"), 0);

    const activity = new ProjectActivityIndex(new Set([join(project, "node_modules")]), NOW);
    const result = activity.forArtifact(join(project, "node_modules"));
    expect(result.root).toBe(project);
    expect(result.confidence).toBe("proven");
    expect(Math.round((NOW - result.activeMs!) / DAY)).toBe(2);
  });

  test("direct marker probes find .git and package.json even when a folder has >300 entries", () => {
    const project = join(root, "crowded");
    mkdirSync(join(project, ".git", "logs"), { recursive: true });
    mkdirSync(join(project, "packages", "sub", "node_modules"), { recursive: true });
    for (let i = 0; i < 300; i += 1) {
      const f = join(project, `entry-${String(i).padStart(3, "0")}.txt`);
      writeFileSync(f, "x");
      at(f, 60);
    }
    writeFileSync(join(project, "package.json"), "{}");
    writeFileSync(join(project, ".git", "index"), "");
    at(join(project, "package.json"), 60);
    at(join(project, ".git", "index"), 5);
    at(join(project, "packages"), 60);
    at(join(project, "packages", "sub"), 60);

    const activity = new ProjectActivityIndex(
      new Set([join(project, "packages", "sub", "node_modules")]),
      NOW,
    );
    const result = activity.forArtifact(join(project, "packages", "sub", "node_modules"));
    expect(result.root).toBe(project);
    expect(result.confidence).toBe("proven");
    expect(Math.round((NOW - result.activeMs!) / DAY)).toBe(5);
  });

  test("projectRoot() and gitActivity() stop at $HOME and never adopt home manifests or dotfiles .git", () => {
    const fakeHome = join(root, "fake-home");
    const scratch = join(fakeHome, "scratch");
    const artifact = join(scratch, "node_modules");
    mkdirSync(join(fakeHome, ".git"), { recursive: true });
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(fakeHome, "package.json"), "{}");
    writeFileSync(join(fakeHome, ".git", "index"), "");
    writeFileSync(join(scratch, "notes.txt"), "hi");
    at(join(fakeHome, "package.json"), 1);
    at(join(fakeHome, ".git", "index"), 1);
    at(join(scratch, "notes.txt"), 50);

    const activity = new ProjectActivityIndex(new Set([artifact]), NOW, { homeDir: fakeHome });
    const result = activity.forArtifact(artifact);
    expect(result.root).toBe(scratch);
    expect(result.confidence).toBe("proven");
    expect(Math.round((NOW - result.activeMs!) / DAY)).toBe(50);
  });

  test("D4: exceeding nested walk bounds (entries, dirs, depth) yields unknown activity", () => {
    const project = join(root, "bounded");
    mkdirSync(join(project, "src", "a", "b", "c"), { recursive: true });
    mkdirSync(join(project, "node_modules"));
    writeFileSync(join(project, "package.json"), "{}");
    writeFileSync(join(project, "src", "a", "b", "c", "leaf.ts"), "export {};");
    at(join(project, "package.json"), 90);
    at(join(project, "src"), 90);
    at(join(project, "src", "a"), 90);
    at(join(project, "src", "a", "b"), 90);
    at(join(project, "src", "a", "b", "c"), 90);
    at(join(project, "src", "a", "b", "c", "leaf.ts"), 90);

    const artifact = join(project, "node_modules");
    const depthCapped = new ProjectActivityIndex(new Set([artifact]), NOW, { maxDepth: 2 });
    expect(depthCapped.forArtifact(artifact)).toEqual({
      root: project,
      activeMs: undefined,
      confidence: "unknown",
    });

    const entryCapped = new ProjectActivityIndex(new Set([artifact]), NOW, { maxEntries: 2 });
    expect(entryCapped.forArtifact(artifact)).toEqual({
      root: project,
      activeMs: undefined,
      confidence: "unknown",
    });

    const dirCapped = new ProjectActivityIndex(new Set([artifact]), NOW, { maxDirs: 2 });
    expect(dirCapped.forArtifact(artifact)).toEqual({
      root: project,
      activeMs: undefined,
      confidence: "unknown",
    });
  });

  test("D4: unreadable subdirectory yields unknown activity", () => {
    if (
      process.platform === "win32" ||
      (typeof process.geteuid === "function" && process.geteuid() === 0)
    ) {
      return;
    }
    const project = join(root, "unreadable");
    const secret = join(project, "src", "secret");
    mkdirSync(secret, { recursive: true });
    mkdirSync(join(project, "node_modules"));
    writeFileSync(join(project, "package.json"), "{}");
    at(join(project, "package.json"), 90);
    at(join(project, "src"), 90);
    chmodSync(secret, 0o000);
    try {
      const artifact = join(project, "node_modules");
      const activity = new ProjectActivityIndex(new Set([artifact]), NOW);
      expect(activity.forArtifact(artifact)).toEqual({
        root: project,
        activeMs: undefined,
        confidence: "unknown",
      });
    } finally {
      chmodSync(secret, 0o755);
    }
  });

  test("D4: directory with only ignored artifacts has unknown activity", () => {
    const project = join(root, "empty-proj");
    const artifact = join(project, "node_modules");
    mkdirSync(artifact, { recursive: true });
    const activity = new ProjectActivityIndex(new Set([artifact]), NOW);
    expect(activity.forArtifact(artifact)).toEqual({
      root: project,
      activeMs: undefined,
      confidence: "unknown",
    });
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
