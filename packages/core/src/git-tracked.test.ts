import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTrackedPaths } from "./git-tracked.js";

let root: string;
const git = (...args: string[]) =>
  spawnSync("git", ["-C", root, ...args], { stdio: "ignore", env: { ...process.env } });

function write(rel: string, contents = "x\n") {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sweep-git-tracked-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasGit)("git-tracked candidates", () => {
  test("a folder holding a committed file is tracked; build output is not", () => {
    write("dist/vendor.js");
    write("node_modules/pkg/index.js");
    git("add", "dist/vendor.js");
    git("commit", "-qm", "init");
    const dist = join(root, "dist");
    const modules = join(root, "node_modules");
    expect(gitTrackedPaths([dist, modules])).toEqual(new Set([dist]));
  });

  test("a staged but uncommitted file counts: it is in the index", () => {
    write("out/notes.md");
    git("add", "out/notes.md");
    expect(gitTrackedPaths([join(root, "out")]).size).toBe(1);
  });

  test("glob characters in a folder name are matched literally", () => {
    write("src/a.ts");
    git("add", "src/a.ts");
    mkdirSync(join(root, "*"));
    expect(gitTrackedPaths([join(root, "*")]).size).toBe(0);
  });

  test("a hostile fsmonitor in the repository's config never runs", () => {
    const marker = join(root, "PWNED");
    write("dist/a.js");
    git("add", "dist/a.js");
    // Set last: a hostile clone arrives with this already in .git/config.
    git("config", "core.fsmonitor", `touch ${marker}`);
    expect(gitTrackedPaths([join(root, "dist")]).size).toBe(1);
    expect(existsSync(marker)).toBe(false);
  });

  test("paths outside any repository are left alone", () => {
    const outside = mkdtempSync(join(tmpdir(), "sweep-no-git-"));
    try {
      expect(gitTrackedPaths([join(outside, "dist")]).size).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasGit)("plans block tracked content", () => {
  test("a committed artifact-named folder is blocked; an ignored one stays selectable", async () => {
    const { scanToPlan } = await import("./engine.js");
    const { DEFAULT_CONFIG } = await import("./config.js");
    write("package.json", "{}\n");
    write(".next/committed.html");
    write("node_modules/pkg/index.js");
    write(".gitignore", "node_modules\n");
    git("add", "package.json", ".gitignore", ".next/committed.html");
    git("commit", "-qm", "init");
    const { plan } = await scanToPlan(root, DEFAULT_CONFIG);
    const byName = new Map(plan.candidates.map((candidate) => [candidate.name, candidate]));
    expect(byName.get(".next")?.riskTier).toBe("blocked");
    expect(byName.get(".next")?.reasons).toContain("git-tracked");
    expect(plan.selectedCandidateIds).not.toContain(byName.get(".next")?.id);
    expect(byName.get("node_modules")?.riskTier).toBe("safe");
  });
});
