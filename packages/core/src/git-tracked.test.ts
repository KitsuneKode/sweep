import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GIT_ENV,
  gitEnv,
  gitSafeArgs,
  gitTrackedPaths,
  gitTrackedPathsViaEngine,
  gitTrackedPathsViaGit,
} from "./git-tracked.js";
import { isRustEngineAvailable } from "./rust-engine.js";

let root: string;
let emptyGitConfig: string;

function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^git_/i.test(k)) env[k] = v;
  }
  env.GIT_CONFIG_GLOBAL = emptyGitConfig;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_AUTHOR_NAME = "t";
  env.GIT_AUTHOR_EMAIL = "t@example.com";
  env.GIT_COMMITTER_NAME = "t";
  env.GIT_COMMITTER_EMAIL = "t@example.com";
  return env;
}

const git = (...args: string[]) =>
  spawnSync("git", ["-C", root, ...args], { stdio: "ignore", env: isolatedGitEnv() });

function write(rel: string, contents = "x\n") {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sweep-git-tracked-"));
  emptyGitConfig = join(root, ".empty-gitconfig");
  writeFileSync(emptyGitConfig, "");
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

test("GIT_ENV and gitEnv force C locale and drop inherited GIT_* overrides", () => {
  expect(GIT_ENV.LC_ALL).toBe("C");
  expect(GIT_ENV.LANG).toBe("C");
  expect(GIT_ENV.GIT_NO_LAZY_FETCH).toBe("1");
  expect(GIT_ENV.GIT_NO_REPLACE_OBJECTS).toBe("1");
  expect(GIT_ENV.GIT_TERMINAL_PROMPT).toBe("0");
  expect(GIT_ENV.GIT_OPTIONAL_LOCKS).toBe("0");

  const sanitized = gitEnv({
    PATH: "/usr/bin",
    GIT_DIR: "/other/.git",
    GIT_WORK_TREE: "/other",
    GIT_INDEX_FILE: "/other/.git/index",
    GIT_OBJECT_DIRECTORY: "/other/.git/objects",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/alt",
    GIT_COMMON_DIR: "/other/.git",
    GIT_SSH_COMMAND: "evil",
  });
  expect(sanitized.GIT_DIR).toBeUndefined();
  expect(sanitized.GIT_WORK_TREE).toBeUndefined();
  expect(sanitized.GIT_INDEX_FILE).toBeUndefined();
  expect(sanitized.GIT_OBJECT_DIRECTORY).toBeUndefined();
  expect(sanitized.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
  expect(sanitized.GIT_COMMON_DIR).toBeUndefined();
  expect(sanitized.GIT_SSH_COMMAND).toBeUndefined();
  expect(sanitized.GIT_NO_LAZY_FETCH).toBe("1");
  expect(sanitized.GIT_NO_REPLACE_OBJECTS).toBe("1");
  expect(sanitized.LC_ALL).toBe("C");

  const args = gitSafeArgs();
  expect(args).toContain("protocol.allow=never");
  expect(args).toContain("core.fsmonitor=false");
  expect(args.some((arg) => arg.startsWith("core.hooksPath="))).toBe(true);
});

test.skipIf(!hasGit)(
  "inherited GIT_DIR and GIT_WORK_TREE do not redirect tracked-path checks",
  () => {
    const other = mkdtempSync(join(tmpdir(), "sweep-other-repo-"));
    try {
      spawnSync("git", ["-C", other, "init", "-q"], { stdio: "ignore", env: isolatedGitEnv() });
      write("dist/vendor.js");
      git("add", "dist/vendor.js");
      git("commit", "-qm", "init");

      const prevGitDir = process.env.GIT_DIR;
      const prevWorkTree = process.env.GIT_WORK_TREE;
      process.env.GIT_DIR = join(other, ".git");
      process.env.GIT_WORK_TREE = other;
      try {
        const dist = join(root, "dist");
        expect(gitTrackedPathsViaGit([dist])).toEqual(new Set([dist]));
        expect(gitTrackedPaths([dist])).toEqual(new Set([dist]));
      } finally {
        if (prevGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = prevGitDir;
        if (prevWorkTree === undefined) delete process.env.GIT_WORK_TREE;
        else process.env.GIT_WORK_TREE = prevWorkTree;
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasGit)(
  "split-index tracked checks stay read-only and preserve sharedindex mtime",
  () => {
    write("dist/vendor.js");
    write("node_modules/pkg/index.js");
    git("add", "dist/vendor.js");
    git("commit", "-qm", "init");
    git("update-index", "--split-index");

    const sharedName = readdirSync(join(root, ".git")).find((name) =>
      name.startsWith("sharedindex."),
    );
    expect(sharedName).toBeDefined();
    const sharedPath = join(root, ".git", sharedName!);
    const pinned = new Date("2025-01-01T00:00:00.000Z");
    utimesSync(sharedPath, pinned, pinned);
    const beforeMs = Math.floor(statSync(sharedPath).mtimeMs);

    const targets = [join(root, "dist"), join(root, "node_modules")];
    expect(gitTrackedPaths(targets)).toEqual(new Set([join(root, "dist")]));
    expect(Math.floor(statSync(sharedPath).mtimeMs)).toBe(beforeMs);

    if (isRustEngineAvailable()) {
      expect(gitTrackedPathsViaEngine(targets)).toEqual(new Set([join(root, "dist")]));
      expect(Math.floor(statSync(sharedPath).mtimeMs)).toBe(beforeMs);
    }
  },
);

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
