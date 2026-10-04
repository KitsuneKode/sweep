import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clean } from "./cleaner.js";
import { readFilesystemIdentity } from "./filesystem-identity.js";
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

test("plan construction cannot invent missing scan approval snapshots", () => {
  mkdirSync(dir("node_modules"));
  const plan = buildPlan(tmpDir, {
    entries: [
      {
        path: dir("node_modules"),
        name: "node_modules",
        entryType: "directory",
        isSymlink: false,
        estimatedBytes: 0,
      },
    ],
    scannedDirs: 1,
    skippedDirs: 0,
    estimatedTotalBytes: 0,
    exact: false,
  });
  expect(plan.targetIdentity).toBeUndefined();
  expect(plan.candidates[0]?.identity).toBeUndefined();
  const checked = revalidateCandidates(plan.candidates, tmpDir);
  expect(checked.ready).toHaveLength(0);
  expect(checked.failedPaths[0]?.error).toContain("identity");
  expect(existsSync(dir("node_modules"))).toBe(true);
});

describe("planner", () => {
  test.skipIf(process.platform === "win32")(
    "protects symlink entries behind an alias into VCS metadata",
    async () => {
      mkdirSync(dir(".git"));
      writeFileSync(dir("kept"), "keep");
      symlinkSync(dir("kept"), dir(".git", "node_modules"));
      symlinkSync(dir(".git"), dir("alias"), "dir");
      const candidate = toCandidate({
        path: dir("alias", "node_modules"),
        name: "node_modules",
        estimatedBytes: 0,
        isSymlink: true,
        entryType: "symlink",
      });
      const result = revalidateCandidates([candidate], tmpDir);
      expect(result.ready).toEqual([]);
      expect(result.failedPaths[0]?.code).toBe("protected_path");
      // The worker repeats the parent protection at the destructive boundary.
      const cleaned = await clean([candidate], { containmentRoot: tmpDir });
      expect(cleaned.deleted).toEqual([]);
      expect(cleaned.failedPaths[0]?.code).toBe("protected_path");
      expect(lstatSync(dir(".git", "node_modules")).isSymbolicLink()).toBe(true);
      expect(existsSync(dir("kept"))).toBe(true);
    },
  );

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

  test("opt-in catalog names are dangerous and never pre-selected", () => {
    // A curated name like `dist` can hold authored files - that is exactly why
    // it ships disabled. Enabling the pattern consents to scanning for it,
    // not to selecting it: tier + reasons must say so on both engines.
    const optInNames = ["dist", "build", "out", "coverage", "pkg.egg-info"];
    const result: ScanResult = {
      entries: optInNames.map((name) => ({
        path: dir(name),
        name,
        estimatedBytes: 1,
        isSymlink: false,
        entryType: "directory",
      })),
      estimatedTotalBytes: 5,
      scannedDirs: 1,
      skippedDirs: 0,
      exact: false,
    };

    const plan = buildPlan(tmpDir, result);

    expect(plan.selectedCandidateIds).toHaveLength(0);
    for (const candidate of plan.candidates) {
      expect(candidate.riskTier).toBe("dangerous");
      expect(candidate.selectedByDefault).toBe(false);
      expect(candidate.reasons).toContain("opt-in-pattern");
    }
  });

  test("a default-catalog name found via any pattern keeps the safe tier", () => {
    // Trust follows the matched name, not which pattern fired: a `node_modules`
    // dir is dependency output even when a custom `*` glob surfaced it.
    const candidate = toCandidate({
      path: dir("node_modules"),
      name: "node_modules",
      estimatedBytes: 1,
      isSymlink: false,
      entryType: "directory",
    });

    expect(candidate.riskTier).toBe("safe");
    expect(candidate.reasons).toContain("default-pattern");
    expect(candidate.selectedByDefault).toBe(true);
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
    // outside the target - rm would recurse through the link.
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

  test("revalidateCandidates refuses the target root itself", () => {
    // A forged plan can name the root as a candidate - the scan never emits
    // it, but the apply path must not rm -r the project top (incl. .git).
    const candidate = toCandidate({
      path: tmpDir,
      name: "project",
      estimatedBytes: 0,
      isSymlink: false,
      entryType: "directory",
    });

    const { ready, failedPaths } = revalidateCandidates([candidate], tmpDir);

    expect(ready).toHaveLength(0);
    expect(failedPaths[0]?.code).toBe("protected_path");
    expect(failedPaths[0]?.error).toContain("target directory itself");
  });

  test("revalidateCandidates refuses the root spelled with dot segments", () => {
    // "target/." and "target/sub/.." resolve to the target root - the
    // canonical-equality check must catch spellings past the lexical one.
    for (const spelling of [`${tmpDir}/.`, `${tmpDir}/sub/../`]) {
      const candidate = toCandidate({
        path: spelling,
        name: "project",
        estimatedBytes: 0,
        isSymlink: false,
        entryType: "directory",
      });

      const { ready, failedPaths } = revalidateCandidates([candidate], tmpDir);

      expect(ready).toHaveLength(0);
      expect(failedPaths[0]?.code).toBe("protected_path");
    }
  });

  test("revalidateCandidates refuses candidates inside VCS metadata", () => {
    // riskTier is plan-controlled JSON - a forged "safe" tier must not bypass
    // the .git protection that inferRiskTier applies at scan time.
    mkdirSync(dir(".git", "objects"), { recursive: true });
    const candidate = toCandidate({
      path: dir(".git"),
      name: ".git",
      estimatedBytes: 0,
      isSymlink: false,
      entryType: "directory",
    });

    const { ready, failedPaths } = revalidateCandidates([candidate], tmpDir);

    expect(ready).toHaveLength(0);
    expect(failedPaths[0]?.code).toBe("protected_path");
    expect(existsSync(dir(".git"))).toBe(true);
  });

  test("revalidateCandidates keeps symlink candidates (unlink-only is already safe)", () => {
    if (process.platform === "win32") return;
    const outside = mkdtempSync(join(tmpdir(), "sweep-outside-"));
    symlinkSync(outside, dir("linked-dist"));
    const candidate = toCandidate({
      path: dir("linked-dist"),
      identity: readFilesystemIdentity(dir("linked-dist")),
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

describe("revalidateCandidates canonical spelling", () => {
  test("rejects a trailing-separator path spelling before any syscall", () => {
    // lstat("/t/sub/") follows a leaf symlink to a directory - the delete-time
    // symlink check would never see the link. A trailing-separator path can
    // only come from a forged/corrupt plan: refuse it as a failed entry.
    mkdirSync(dir("sub", "node_modules"), { recursive: true });
    const candidate = toCandidate({
      path: `${dir("sub", "node_modules")}/`,
      name: "node_modules",
      estimatedBytes: 0,
      isSymlink: false,
      entryType: "directory",
    });

    const { ready, failedPaths } = revalidateCandidates([candidate], tmpDir);

    expect(ready).toHaveLength(0);
    expect(failedPaths[0]?.code).toBe("filesystem_error");
    expect(failedPaths[0]?.error).toContain("canonical");
    expect(existsSync(dir("sub", "node_modules"))).toBe(true);
  });

  test("rejects dot-segment and duplicate-separator spellings", () => {
    mkdirSync(dir("node_modules"), { recursive: true });
    for (const spelling of [
      `${dir("node_modules")}/.`,
      `${tmpDir}//node_modules`,
      `${tmpDir}/x/../node_modules`,
    ]) {
      const candidate = toCandidate({
        path: spelling,
        name: "node_modules",
        estimatedBytes: 0,
        isSymlink: false,
        entryType: "directory",
      });
      const { ready, failedPaths } = revalidateCandidates([candidate], tmpDir);
      // Inside-root spellings land on canonical; outside-root variants land
      // on outside_target - either way nothing reaches ready as written.
      expect(ready).toHaveLength(0);
      expect(failedPaths).toHaveLength(1);
    }
  });

  test("a cancelled revalidation leaves later candidates unattempted", () => {
    // Rust parity: a stop during revalidation must not manufacture failures
    // for candidates it never reached - they read as unattempted upstream.
    mkdirSync(dir("node_modules"), { recursive: true });
    mkdirSync(dir(".vite"), { recursive: true });
    const mk = (name: string) =>
      toCandidate({
        identity: readFilesystemIdentity(dir(name)),
        path: dir(name),
        name,
        estimatedBytes: 0,
        isSymlink: false,
        entryType: "directory",
      });
    let calls = 0;
    const { ready, failedPaths } = revalidateCandidates(
      [mk("node_modules"), mk(".vite")],
      tmpDir,
      () => calls++ > 0, // first call false, every later call true
    );

    expect(ready).toHaveLength(1);
    expect(failedPaths).toHaveLength(0);
  });
});
