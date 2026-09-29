import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanEntry, ScanResult } from "@kitsunekode/sweep-protocol";
import {
  buildPlan,
  compileSelectedCandidateIds,
  revalidateCandidates,
  toCandidate,
} from "./planner.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sweep-planner-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const dir = (...parts: string[]) => join(tmpDir, ...parts);

describe("planner", () => {
  test("buildPlan selects safe defaults and excludes dangerous custom patterns", () => {
    const safeEntry: ScanEntry = {
      path: dir("node_modules"),
      name: "node_modules",
      estimatedBytes: 10,
      isSymlink: false,
      entryType: "directory",
    };
    const dangerousEntry: ScanEntry = {
      path: dir("custom-cache"),
      name: "custom-cache",
      estimatedBytes: 5,
      isSymlink: false,
      entryType: "directory",
    };

    const result: ScanResult = {
      entries: [safeEntry, dangerousEntry],
      estimatedTotalBytes: 15,
      scannedDirs: 3,
      skippedDirs: 0,
      exact: false,
    };

    const plan = buildPlan(tmpDir, result);

    expect(plan.candidates).toHaveLength(2);
    expect(plan.selectedCandidateIds).toHaveLength(1);
    expect(plan.summary.selectedCount).toBe(1);
    expect(plan.summary.riskCounts.safe).toBe(1);
    expect(plan.summary.riskCounts.dangerous).toBe(1);
    expect(
      plan.candidates.find((candidate) => candidate.name === "custom-cache")?.selectedByDefault,
    ).toBe(false);
  });

  test("revalidateCandidates rejects entry type drift", () => {
    mkdirSync(dir("node_modules"));
    const candidate = toCandidate({
      path: dir("node_modules"),
      name: "node_modules",
      estimatedBytes: 0,
      isSymlink: false,
      entryType: "directory",
    });

    rmSync(dir("node_modules"), { recursive: true, force: true });
    writeFileSync(dir("node_modules"), "file now");

    const { ready, failedPaths } = revalidateCandidates([candidate]);

    expect(ready).toHaveLength(0);
    expect(failedPaths).toHaveLength(1);
    expect(failedPaths[0]?.code).toBe("changed_entry_type");
    expect(failedPaths[0]?.error).toContain("entry type changed");
  });

  test("revalidateCandidates rejects candidates behind a swapped-in symlinked ancestor", () => {
    if (process.platform === "win32") return; // symlink perms vary on Windows
    const outside = mkdtempSync(join(tmpdir(), "sweep-outside-"));
    mkdirSync(dir("sub", "node_modules"), { recursive: true });
    const candidate = toCandidate({
      path: dir("sub", "node_modules"),
      name: "node_modules",
      estimatedBytes: 0,
      isSymlink: false,
      entryType: "directory",
    });

    // The candidate passes a lexical root check, but "sub" now resolves
    // outside the target — rm would recurse through the link.
    rmSync(dir("sub"), { recursive: true });
    symlinkSync(outside, dir("sub"));
    mkdirSync(join(outside, "node_modules"), { recursive: true });
    try {
      const { ready, failedPaths } = revalidateCandidates([candidate], tmpDir);

      expect(ready).toHaveLength(0);
      expect(failedPaths).toHaveLength(1);
      expect(failedPaths[0]?.code).toBe("outside_target");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("revalidateCandidates keeps symlink candidates (unlink-only is already safe)", () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "sweep-outside-"));
    symlinkSync(outside, dir("linked-dist"));
    const candidate = toCandidate({
      path: dir("linked-dist"),
      name: "dist",
      estimatedBytes: 0,
      isSymlink: true,
      entryType: "symlink",
    });

    try {
      const { ready, failedPaths } = revalidateCandidates([candidate], tmpDir);
      expect(ready).toHaveLength(1);
      expect(failedPaths).toHaveLength(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("compileSelectedCandidateIds respects selection mode and dangerous opt-in", () => {
    const safeCandidate = toCandidate({
      path: dir("node_modules"),
      name: "node_modules",
      estimatedBytes: 10,
      isSymlink: false,
      entryType: "directory",
    });
    const cautionCandidate = toCandidate({
      path: dir("linked-dist"),
      name: "dist",
      estimatedBytes: 5,
      isSymlink: true,
      entryType: "symlink",
    });
    const dangerousCandidate = toCandidate({
      path: dir("custom-cache"),
      name: "custom-cache",
      estimatedBytes: 3,
      isSymlink: false,
      entryType: "directory",
    });

    const candidates = [safeCandidate, cautionCandidate, dangerousCandidate];

    expect(
      compileSelectedCandidateIds(candidates, { mode: "default", includeDangerous: false }),
    ).toEqual([safeCandidate.id]);
    expect(
      compileSelectedCandidateIds(candidates, { mode: "all", includeDangerous: false }),
    ).toEqual([safeCandidate.id, cautionCandidate.id]);
    expect(
      compileSelectedCandidateIds(candidates, { mode: "all", includeDangerous: true }),
    ).toEqual([safeCandidate.id, cautionCandidate.id, dangerousCandidate.id]);
  });
});
