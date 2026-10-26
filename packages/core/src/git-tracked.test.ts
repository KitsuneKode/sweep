import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTrackedPaths, gitTrackedPathsViaEngine, gitTrackedPathsViaGit } from "./git-tracked.js";
import { isRustEngineAvailable } from "./rust-engine.js";

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
  // A developer's global commit signing must not make test commits fail.
  git("config", "commit.gpgsign", "false");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const IMPLEMENTATIONS = [
  { name: "git", run: gitTrackedPathsViaGit, available: hasGit },
  {
    name: "engine index reader",
    run: (paths: string[]) => gitTrackedPathsViaEngine(paths) ?? new Set<string>(["<no answer>"]),
    available: hasGit && isRustEngineAvailable(),
  },
];

for (const impl of IMPLEMENTATIONS) {
  const gitTrackedPaths = impl.run;
  describe.skipIf(!impl.available)(`git-tracked candidates (${impl.name})`, () => {
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
      // As a glob, `dist[1]` would match the tracked `dist1`; as a path it must not.
      write("dist1/a.js");
      git("add", "dist1/a.js");
      mkdirSync(join(root, "dist[1]"));
      expect(gitTrackedPaths([join(root, "dist[1]")]).size).toBe(0);
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

  describe.skipIf(!impl.available)(`index layouts (${impl.name})`, () => {
    const commitDist = () => {
      write("dist/vendor.js");
      write("node_modules/pkg/index.js");
      git("add", "dist/vendor.js");
      git("commit", "-qm", "init");
    };
    const expectDistOnly = (base = root) =>
      expect(gitTrackedPaths([join(base, "dist"), join(base, "node_modules")])).toEqual(
        new Set([join(base, "dist")]),
      );

    test("index version 4 (path prefix compression)", () => {
      commitDist();
      git("update-index", "--index-version", "4");
      expectDistOnly();
    });

    test("a split index", () => {
      commitDist();
      git("update-index", "--split-index");
      expectDistOnly();
    });

    test("a linked worktree reads its own index", () => {
      commitDist();
      const tree = join(root, "..", `${root.split(/[\\/]/).pop()}-wt`);
      git("worktree", "add", "-q", tree);
      try {
        write(`../${tree.split(/[\\/]/).pop()}/node_modules/x.js`);
        expectDistOnly(tree);
      } finally {
        rmSync(tree, { recursive: true, force: true });
      }
    });

    test("a SHA-256 repository", () => {
      const sha = mkdtempSync(join(tmpdir(), "sweep-git-sha256-"));
      try {
        const run = (...args: string[]) =>
          spawnSync("git", ["-C", sha, ...args], { stdio: "ignore" }).status;
        if (run("init", "-q", "--object-format=sha256") !== 0) return; // git too old
        run("config", "user.email", "t@example.com");
        run("config", "user.name", "t");
        run("config", "commit.gpgsign", "false");
        mkdirSync(join(sha, "dist"));
        writeFileSync(join(sha, "dist", "a.js"), "x");
        run("add", "dist/a.js");
        run("commit", "-qm", "init");
        expect(gitTrackedPaths([join(sha, "dist"), join(sha, "build")])).toEqual(
          new Set([join(sha, "dist")]),
        );
      } finally {
        rmSync(sha, { recursive: true, force: true });
      }
    });

    test("a prefix sibling is not a parent: dist-x tracked, dist not", () => {
      write("dist-x/a.js");
      write("dist/b.js");
      git("add", "dist-x/a.js");
      git("commit", "-qm", "init");
      expect(gitTrackedPaths([join(root, "dist"), join(root, "dist-x")])).toEqual(
        new Set([join(root, "dist-x")]),
      );
    });
  });
}

test("the public check agrees with git on an ordinary repository", () => {
  if (!hasGit) return;
  write("dist/vendor.js");
  git("add", "dist/vendor.js");
  git("commit", "-qm", "init");
  const paths = [join(root, "dist"), join(root, "out")];
  expect(gitTrackedPaths(paths)).toEqual(gitTrackedPathsViaGit(paths));
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
