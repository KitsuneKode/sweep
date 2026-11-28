import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { lookupExecutable } from "./executable-lookup.js";
import { readTrackedPathsFromIndex } from "./git-index.js";
import {
  GIT_ENV,
  gitEnv,
  gitSafeArgs,
  gitTrackedPaths,
  gitTrackedPathsViaEngine,
  gitTrackedPathsViaGit,
  normalizeWinCanonical,
  sameRepoRoot,
  scanCandidateForDotGit,
} from "./git-tracked.js";
import { isRustEngineAvailable } from "./rust-engine.js";

// Fake engines in this file are `#!` scripts, which need the development opt-in.
const previousScriptEngineOptIn = process.env.SWEEP_ALLOW_SCRIPT_ENGINE;
beforeAll(() => {
  process.env.SWEEP_ALLOW_SCRIPT_ENGINE = "1";
});
afterAll(() => {
  if (previousScriptEngineOptIn === undefined) delete process.env.SWEEP_ALLOW_SCRIPT_ENGINE;
  else process.env.SWEEP_ALLOW_SCRIPT_ENGINE = previousScriptEngineOptIn;
});

let root: string;
let emptyGitConfig: string;

function isolatedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^git_/i.test(k)) env[k] = v;
  }
  env.LC_ALL = "C";
  env.LANG = "C";
  env.LANGUAGE = "C";
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
    run: (paths: string[]) =>
      gitTrackedPathsViaEngine(paths) ?? {
        tracked: new Set<string>(["<no answer>"]),
        unknown: new Set<string>(),
        containsGitRepo: new Set<string>(),
      },
    available: hasGit && isRustEngineAvailable(),
  },
];

for (const impl of IMPLEMENTATIONS) {
  const gitTrackedPaths = (paths: string[]) => impl.run(paths).tracked;
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
          spawnSync("git", ["-C", sha, ...args], { stdio: "ignore", env: gitEnv() }).status;
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
  expect(args).toContain("protocol.file.allow=never");
  expect(args).toContain("protocol.git.allow=never");
  expect(args).toContain("protocol.ssh.allow=never");
  expect(args).toContain("protocol.http.allow=never");
  expect(args).toContain("protocol.https.allow=never");
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
        const expected = {
          tracked: new Set([dist]),
          unknown: new Set<string>(),
          containsGitRepo: new Set<string>(),
        };
        expect(gitTrackedPathsViaGit([dist])).toEqual(expected);
        expect(gitTrackedPaths([dist])).toEqual(expected);
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
  "split-index tracked checks stay read-only in index parsers and agree with git",
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

    // Pure JS index reader stays read-only and preserves sharedindex mtime.
    expect(readTrackedPathsFromIndex(root)).toEqual(["dist/vendor.js"]);
    expect(Math.floor(statSync(sharedPath).mtimeMs)).toBe(beforeMs);

    const targets = [join(root, "dist"), join(root, "node_modules")];
    const expected = {
      tracked: new Set([join(root, "dist")]),
      unknown: new Set<string>(),
      containsGitRepo: new Set<string>(),
    };

    // Native index-reader fallback (no git on PATH) also stays read-only and preserves mtime.
    if (isRustEngineAvailable()) {
      const prevPath = process.env.PATH;
      try {
        process.env.PATH = "";
        expect(gitTrackedPathsViaEngine(targets)).toEqual(expected);
        expect(Math.floor(statSync(sharedPath).mtimeMs)).toBe(beforeMs);
      } finally {
        if (prevPath === undefined) delete process.env.PATH;
        else process.env.PATH = prevPath;
      }
    }

    // With git on PATH, both engines agree on tracked status.
    expect(gitTrackedPaths(targets)).toEqual(expected);
    if (isRustEngineAvailable()) {
      expect(gitTrackedPathsViaEngine(targets)).toEqual(expected);
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

  test("JS engine marks repo candidates dangerous with tracked-status-unknown when PATH has no git", async () => {
    const { scanToPlan } = await import("./engine.js");
    const { DEFAULT_CONFIG } = await import("./config.js");
    write("package.json", "{}\n");
    write("node_modules/pkg/index.js");
    const outside = mkdtempSync(join(tmpdir(), "sweep-no-repo-"));
    const tempBin = mkdtempSync(join(tmpdir(), "sweep-node-only-bin-"));
    mkdirSync(join(outside, "node_modules"), { recursive: true });
    writeFileSync(join(outside, "package.json"), "{}\n");
    writeFileSync(join(outside, "node_modules", "a.js"), "x\n");
    const nodePath = lookupExecutable("node").resolvedPath;
    const nodeDir = nodePath ? dirname(nodePath) : undefined;
    let pathWithoutGit = tempBin;
    if (nodePath && nodeDir) {
      if (!lookupExecutable("git", { pathEnv: nodeDir }).resolvedPath) {
        pathWithoutGit = `${tempBin}${delimiter}${nodeDir}`;
      } else {
        const target = join(tempBin, basename(nodePath));
        if (process.platform === "win32") copyFileSync(nodePath, target);
        else symlinkSync(nodePath, target);
      }
    }

    const previousPath = process.env.PATH;
    const previousEngine = process.env.SWEEP_ENGINE_PATH;
    try {
      process.env.PATH = pathWithoutGit;
      process.env.SWEEP_ENGINE_PATH = join(root, "missing-sweep-engine");
      expect(lookupExecutable("git").resolvedPath).toBeUndefined();
      if (nodePath) expect(lookupExecutable("node").resolvedPath).toBeDefined();

      const { plan } = await scanToPlan(root, DEFAULT_CONFIG);
      const nm = plan.candidates.find((candidate) => candidate.name === "node_modules");
      expect(nm?.riskTier).toBe("dangerous");
      expect(nm?.reasons).toContain("tracked-status-unknown");
      expect(nm?.selectedByDefault).toBe(false);
      expect(plan.selectedCandidateIds).not.toContain(nm?.id);

      const { plan: outsidePlan } = await scanToPlan(outside, DEFAULT_CONFIG);
      const outsideNm = outsidePlan.candidates.find(
        (candidate) => candidate.name === "node_modules",
      );
      expect(outsideNm?.riskTier).toBe("safe");
      expect(outsideNm?.reasons).not.toContain("tracked-status-unknown");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousEngine === undefined) delete process.env.SWEEP_ENGINE_PATH;
      else process.env.SWEEP_ENGINE_PATH = previousEngine;
      rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSync(tempBin, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test.skipIf(!isRustEngineAvailable())(
    "Rust engine marks repo candidates dangerous with tracked-status-unknown when index fallback has no git on PATH",
    async () => {
      const { scanToPlanViaRust } = await import("./rust-engine.js");
      const { DEFAULT_CONFIG } = await import("./config.js");
      write("package.json", "{}\n");
      write("node_modules/pkg/index.js");
      git("add", "package.json");
      git("commit", "-qm", "init");
      git("update-index", "--split-index");
      // Remove the shared base index so the native index reader must reject the split index.
      for (const name of readdirSync(join(root, ".git"))) {
        if (name.startsWith("sharedindex.")) unlinkSync(join(root, ".git", name));
      }

      const previousPath = process.env.PATH;
      try {
        process.env.PATH =
          process.platform === "win32"
            ? "C:\\nonexistent-sweep-no-git"
            : "/nonexistent-sweep-no-git";
        expect(lookupExecutable("git").resolvedPath).toBeUndefined();

        const plan = await scanToPlanViaRust(root, {
          config: DEFAULT_CONFIG,
          selectionPolicy: { mode: "default", includeDangerous: false },
        });
        const nm = plan.candidates.find((candidate) => candidate.name === "node_modules");
        expect(nm?.riskTier).toBe("dangerous");
        expect(nm?.reasons).toContain("tracked-status-unknown");
        expect(nm?.selectedByDefault).toBe(false);
        expect(plan.selectedCandidateIds).not.toContain(nm?.id);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    },
  );

  test("gitfile pointing at an existing directory without an index is unknown in both engines", async () => {
    const { scanToPlan } = await import("./engine.js");
    const { DEFAULT_CONFIG } = await import("./config.js");
    const scratch = mkdtempSync(join(tmpdir(), "sweep-gitfile-no-index-"));
    try {
      const emptyGitdir = join(scratch, "not-a-gitdir");
      const preservedGitdir = join(scratch, "preserved-gitdir");
      mkdirSync(emptyGitdir, { recursive: true });

      write("package.json", "{}\n");
      write("node_modules/pkg/index.js", "module.exports = 1;\n");
      git("add", "package.json", "node_modules/pkg/index.js");
      git("commit", "-qm", "init");
      renameSync(join(root, ".git"), preservedGitdir);
      writeFileSync(join(root, ".git"), `gitdir: ${emptyGitdir.replaceAll("\\", "/")}\n`);

      const nmPath = join(root, "node_modules");
      const expected = {
        tracked: new Set<string>(),
        unknown: new Set([nmPath]),
        containsGitRepo: new Set<string>(),
      };
      expect(gitTrackedPathsViaGit([nmPath])).toEqual(expected);
      expect(gitTrackedPaths([nmPath])).toEqual(expected);
      if (isRustEngineAvailable()) {
        expect(gitTrackedPathsViaEngine([nmPath])).toEqual(expected);
      }

      const { plan: jsPlan } = await scanToPlan(root, DEFAULT_CONFIG);
      const jsNm = jsPlan.candidates.find((candidate) => candidate.name === "node_modules");
      expect(jsNm?.riskTier).toBe("dangerous");
      expect(jsNm?.reasons).toContain("tracked-status-unknown");
      expect(jsNm?.selectedByDefault).toBe(false);
      expect(jsPlan.selectedCandidateIds).not.toContain(jsNm?.id);

      if (isRustEngineAvailable()) {
        const { scanToPlanViaRust } = await import("./rust-engine.js");
        const rustPlan = await scanToPlanViaRust(root, {
          config: DEFAULT_CONFIG,
          selectionPolicy: { mode: "default", includeDangerous: false },
        });
        const rustNm = rustPlan.candidates.find((candidate) => candidate.name === "node_modules");
        expect(rustNm?.riskTier).toBe("dangerous");
        expect(rustNm?.reasons).toContain("tracked-status-unknown");
        expect(rustNm?.selectedByDefault).toBe(false);
        expect(rustPlan.selectedCandidateIds).not.toContain(rustNm?.id);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("empty .git directory without an index is unknown in both engines", () => {
    const fakeRepo = mkdtempSync(join(tmpdir(), "sweep-empty-dot-git-"));
    try {
      mkdirSync(join(fakeRepo, ".git"), { recursive: true });
      const nmPath = join(fakeRepo, "node_modules");
      mkdirSync(nmPath, { recursive: true });
      const expected = {
        tracked: new Set<string>(),
        unknown: new Set([nmPath]),
        containsGitRepo: new Set<string>(),
      };
      expect(gitTrackedPathsViaGit([nmPath])).toEqual(expected);
      expect(gitTrackedPaths([nmPath])).toEqual(expected);
      if (isRustEngineAvailable()) {
        expect(gitTrackedPathsViaEngine([nmPath])).toEqual(expected);
      }
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("valid repo with a deleted index stays empty when git succeeds and is unknown without git", () => {
    write("package.json", "{}\n");
    write("node_modules/pkg/index.js", "module.exports = 1;\n");
    git("add", "package.json", "node_modules/pkg/index.js");
    git("commit", "-qm", "init");
    unlinkSync(join(root, ".git", "index"));

    const nmPath = join(root, "node_modules");
    const empty = {
      tracked: new Set<string>(),
      unknown: new Set<string>(),
      containsGitRepo: new Set<string>(),
    };
    expect(gitTrackedPathsViaGit([nmPath])).toEqual(empty);
    expect(gitTrackedPaths([nmPath])).toEqual(empty);
    if (isRustEngineAvailable()) {
      expect(gitTrackedPathsViaEngine([nmPath])).toEqual(empty);
    }

    const previousPath = process.env.PATH;
    try {
      process.env.PATH =
        process.platform === "win32" ? "C:\\nonexistent-sweep-no-git" : "/nonexistent-sweep-no-git";
      const unknown = {
        tracked: new Set<string>(),
        unknown: new Set([nmPath]),
        containsGitRepo: new Set<string>(),
      };
      expect(gitTrackedPathsViaGit([nmPath])).toEqual(unknown);
      expect(gitTrackedPaths([nmPath])).toEqual(unknown);
      if (isRustEngineAvailable()) {
        expect(gitTrackedPathsViaEngine([nmPath])).toEqual(unknown);
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test.skipIf(process.platform === "win32")(
  "gitTrackedPathsViaGit never executes a planted git binary in cwd via empty or relative PATH",
  () => {
    const work = mkdtempSync(join(tmpdir(), "sweep-git-cwd-"));
    const relDir = join(work, "relbin");
    mkdirSync(join(work, ".git"), { recursive: true });
    mkdirSync(join(work, "dist"), { recursive: true });
    mkdirSync(relDir, { recursive: true });
    const marker = join(work, "git-ran.marker");
    const script = `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\nprintf 'dist/a.js\\0'\nexit 0\n`;
    writeFileSync(join(work, "git"), script);
    writeFileSync(join(relDir, "git"), script);
    chmodSync(join(work, "git"), 0o755);
    chmodSync(join(relDir, "git"), 0o755);

    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    try {
      process.chdir(work);
      for (const pathEnv of ["", ":/nonexistent", "/nonexistent:", "/a::/b", ".", "./relbin"]) {
        process.env.PATH = pathEnv;
        expect(gitTrackedPathsViaGit([join(work, "dist")])).toEqual({
          tracked: new Set(),
          unknown: new Set([join(work, "dist")]),
          containsGitRepo: new Set(),
        });
        expect(existsSync(marker)).toBe(false);
      }
    } finally {
      process.chdir(previousCwd);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(work, { recursive: true, force: true });
    }
  },
);

test("gitEnv drops all inherited GIT_* variables and sets hardened defaults", () => {
  const cleaned = gitEnv({
    PATH: "/usr/bin",
    HOME: "/home/tester",
    GIT_DIR: "/tmp/evil-git",
    GIT_INDEX_FILE: "/tmp/empty-index",
    GIT_WORK_TREE: "/tmp/evil-worktree",
    GIT_OBJECT_DIRECTORY: "/tmp/evil-objects",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/evil-alt",
    GIT_COMMON_DIR: "/tmp/evil-common",
    GIT_CEILING_DIRECTORIES: "/tmp",
    GIT_CONFIG_GLOBAL: "/tmp/evil-config",
    GIT_CONFIG_COUNT: "1",
    git_dir: "/tmp/lower-git",
  });
  expect(cleaned.PATH).toBe("/usr/bin");
  expect(cleaned.HOME).toBe("/home/tester");
  expect(cleaned.GIT_DIR).toBeUndefined();
  expect(cleaned.GIT_INDEX_FILE).toBeUndefined();
  expect(cleaned.GIT_WORK_TREE).toBeUndefined();
  expect(cleaned.GIT_OBJECT_DIRECTORY).toBeUndefined();
  expect(cleaned.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
  expect(cleaned.GIT_COMMON_DIR).toBeUndefined();
  expect(cleaned.GIT_CEILING_DIRECTORIES).toBeUndefined();
  expect(cleaned.GIT_CONFIG_GLOBAL).toBeUndefined();
  expect(cleaned.GIT_CONFIG_COUNT).toBeUndefined();
  expect(cleaned.git_dir).toBeUndefined();
  expect(cleaned.LC_ALL).toBe("C");
  expect(cleaned.GIT_OPTIONAL_LOCKS).toBe("0");
  expect(cleaned.GIT_LITERAL_PATHSPECS).toBe("1");
  expect(cleaned.GIT_TERMINAL_PROMPT).toBe("0");
  expect(cleaned.GIT_NO_LAZY_FETCH).toBe("1");
});

describe.skipIf(!hasGit)("round 5 & round 6 git-tracked invariants (both engines)", () => {
  function makeEmptyIndexRepo(dir: string): { gitDir: string; emptyIndex: string } {
    mkdirSync(dir, { recursive: true });
    const run = (...args: string[]) =>
      expect(
        spawnSync("git", ["-C", dir, ...args], { stdio: "ignore", env: gitEnv() }).status,
      ).toBe(0);
    run("init", "-q", "--object-format=sha1");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    run("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "tmp.txt"), "x\n");
    run("add", "tmp.txt");
    run("rm", "--cached", "-q", "tmp.txt");
    return { gitDir: join(dir, ".git"), emptyIndex: join(dir, ".git", "index") };
  }

  test("32-byte empty index in a gitfile target with no HEAD is unknown in both engines", () => {
    const scratch = mkdtempSync(join(tmpdir(), "sweep-empty-idx-gitfile-"));
    try {
      const { emptyIndex } = makeEmptyIndexRepo(join(scratch, "empty-src"));
      const fakeGitdir = join(scratch, "fake-gitdir");
      const preserved = join(scratch, "preserved");
      mkdirSync(fakeGitdir, { recursive: true });
      copyFileSync(emptyIndex, join(fakeGitdir, "index"));

      write("package.json", "{}\n");
      write("node_modules/pkg/index.js", "module.exports = 1;\n");
      git("add", "package.json", "node_modules/pkg/index.js");
      git("commit", "-qm", "init");
      renameSync(join(root, ".git"), preserved);
      writeFileSync(join(root, ".git"), `gitdir: ${fakeGitdir.replaceAll("\\", "/")}\n`);

      const nmPath = join(root, "node_modules");
      const expected = {
        tracked: new Set<string>(),
        unknown: new Set([nmPath]),
        containsGitRepo: new Set<string>(),
      };
      expect(gitTrackedPathsViaGit([nmPath])).toEqual(expected);
      expect(gitTrackedPaths([nmPath])).toEqual(expected);
      if (isRustEngineAvailable()) {
        expect(gitTrackedPathsViaEngine([nmPath])).toEqual(expected);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("inherited GIT_DIR and GIT_INDEX_FILE cannot spoof tracked status in either engine", () => {
    const scratch = mkdtempSync(join(tmpdir(), "sweep-git-env-spoof-"));
    const prevGitDir = process.env.GIT_DIR;
    const prevGitIndex = process.env.GIT_INDEX_FILE;
    const prevGitWorkTree = process.env.GIT_WORK_TREE;
    try {
      const { gitDir, emptyIndex } = makeEmptyIndexRepo(join(scratch, "empty-repo"));
      write("package.json", "{}\n");
      write("node_modules/pkg/index.js", "module.exports = 1;\n");
      git("add", "package.json", "node_modules/pkg/index.js");
      git("commit", "-qm", "init");

      process.env.GIT_DIR = gitDir;
      process.env.GIT_INDEX_FILE = emptyIndex;
      process.env.GIT_WORK_TREE = join(scratch, "empty-repo");

      const nmPath = join(root, "node_modules");
      const expected = {
        tracked: new Set([nmPath]),
        unknown: new Set<string>(),
        containsGitRepo: new Set<string>(),
      };
      expect(gitTrackedPathsViaGit([nmPath])).toEqual(expected);
      expect(gitTrackedPaths([nmPath])).toEqual(expected);
      if (isRustEngineAvailable()) {
        expect(gitTrackedPathsViaEngine([nmPath])).toEqual(expected);
      }
    } finally {
      if (prevGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prevGitDir;
      if (prevGitIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = prevGitIndex;
      if (prevGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = prevGitWorkTree;
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("nested repo does not hide a parent repo tracking nested/node_modules", () => {
    write("package.json", "{}\n");
    write("nested/node_modules/pkg/index.js", "module.exports = 1;\n");
    git("add", "package.json", "nested/node_modules/pkg/index.js");
    git("commit", "-qm", "init");
    expect(
      spawnSync("git", ["-C", join(root, "nested"), "init", "-q"], {
        stdio: "ignore",
        env: gitEnv(),
      }).status,
    ).toBe(0);

    const nmPath = join(root, "nested", "node_modules");
    const expected = {
      tracked: new Set([nmPath]),
      unknown: new Set<string>(),
      containsGitRepo: new Set<string>(),
    };
    expect(gitTrackedPathsViaGit([nmPath])).toEqual(expected);
    expect(gitTrackedPaths([nmPath])).toEqual(expected);
    if (isRustEngineAvailable()) {
      expect(gitTrackedPathsViaEngine([nmPath])).toEqual(expected);
    }
  });

  test("submodules keep working: tracked submodule files are blocked and untracked folders stay clean", () => {
    const scratch = mkdtempSync(join(tmpdir(), "sweep-submodule-"));
    try {
      const subSrc = join(scratch, "sub-src");
      mkdirSync(join(subSrc, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(subSrc, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
      const runSub = (...args: string[]) =>
        expect(
          spawnSync("git", ["-C", subSrc, ...args], { stdio: "ignore", env: gitEnv() }).status,
        ).toBe(0);
      runSub("init", "-q");
      runSub("config", "user.email", "t@example.com");
      runSub("config", "user.name", "t");
      runSub("config", "commit.gpgsign", "false");
      runSub("add", "node_modules/pkg/index.js");
      runSub("commit", "-qm", "sub init");

      write("package.json", "{}\n");
      git("add", "package.json");
      git("commit", "-qm", "parent init");
      expect(
        spawnSync(
          "git",
          ["-C", root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subSrc, "sub"],
          { stdio: "ignore", env: gitEnv() },
        ).status,
      ).toBe(0);
      git("commit", "-qm", "add sub");

      const subTracked = join(root, "sub", "node_modules");
      const subUntracked = join(root, "sub", "dist");
      mkdirSync(subUntracked, { recursive: true });
      writeFileSync(join(subUntracked, "out.js"), "x\n");

      const expected = {
        tracked: new Set([subTracked]),
        unknown: new Set<string>(),
        containsGitRepo: new Set<string>(),
      };
      expect(gitTrackedPathsViaGit([subTracked, subUntracked])).toEqual(expected);
      expect(gitTrackedPaths([subTracked, subUntracked])).toEqual(expected);
      if (isRustEngineAvailable()) {
        expect(gitTrackedPathsViaEngine([subTracked, subUntracked])).toEqual(expected);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("git exiting 1 makes a healthy repo unknown in both engines without native fallback", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "sweep-fail-git-"));
    const previousPath = process.env.PATH;
    try {
      write("package.json", "{}\n");
      write("node_modules/pkg/index.js", "module.exports = 1;\n");
      git("add", "package.json", "node_modules/pkg/index.js");
      git("commit", "-qm", "init");

      if (process.platform === "win32") {
        copyFileSync(process.execPath, join(fakeBin, "git.exe"));
      } else {
        const fakeGit = join(fakeBin, "git");
        writeFileSync(fakeGit, "#!/bin/sh\nexit 1\n");
        chmodSync(fakeGit, 0o755);
      }

      process.env.PATH = fakeBin;
      const nmPath = join(root, "node_modules");
      const expected = {
        tracked: new Set<string>(),
        unknown: new Set([nmPath]),
        containsGitRepo: new Set<string>(),
      };
      expect(gitTrackedPathsViaGit([nmPath])).toEqual(expected);
      expect(gitTrackedPaths([nmPath])).toEqual(expected);
      if (isRustEngineAvailable()) {
        expect(gitTrackedPathsViaEngine([nmPath])).toEqual(expected);
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(fakeBin, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test.skipIf(process.platform === "win32")(
    "CLI rejects an engine emitting the old SWEEP_TRACKED_V2 header and falls back to git",
    () => {
      const scratch = mkdtempSync(join(tmpdir(), "sweep-v2-engine-"));
      const previousEngine = process.env.SWEEP_ENGINE_PATH;
      try {
        const fakeEngine = join(scratch, "sweep-engine");
        writeFileSync(
          fakeEngine,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then echo "sweep-engine 0.5.2"; exit 0; fi',
            'if [ "$1" = "tracked" ]; then printf "SWEEP_TRACKED_V2\\0"; exit 0; fi',
            "exit 1",
          ].join("\n"),
        );
        chmodSync(fakeEngine, 0o755);

        write("package.json", "{}\n");
        write("node_modules/pkg/index.js", "module.exports = 1;\n");
        git("add", "package.json", "node_modules/pkg/index.js");
        git("commit", "-qm", "init");

        process.env.SWEEP_ENGINE_PATH = fakeEngine;
        const nmPath = join(root, "node_modules");
        expect(gitTrackedPathsViaEngine([nmPath])).toBeNull();
        expect(gitTrackedPaths([nmPath])).toEqual({
          tracked: new Set([nmPath]),
          unknown: new Set<string>(),
          containsGitRepo: new Set<string>(),
        });
      } finally {
        if (previousEngine === undefined) delete process.env.SWEEP_ENGINE_PATH;
        else process.env.SWEEP_ENGINE_PATH = previousEngine;
        rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "backslash in a Unix directory name stays literal in both engines",
    () => {
      write("a\\b/node_modules/pkg/index.js", "module.exports = 1;\n");
      git("add", "a\\b/node_modules/pkg/index.js");
      git("commit", "-qm", "backslash");

      const candidate = join(root, "a\\b", "node_modules");
      const expected = {
        tracked: new Set([candidate]),
        unknown: new Set<string>(),
        containsGitRepo: new Set<string>(),
      };
      expect(gitTrackedPathsViaGit([candidate])).toEqual(expected);
      expect(gitTrackedPaths([candidate])).toEqual(expected);
      if (isRustEngineAvailable()) {
        expect(gitTrackedPathsViaEngine([candidate])).toEqual(expected);
      }
    },
  );

  test("core.ignorecase=true and Unicode NFC/NFD folding agree in both engines", () => {
    write("node_modules/pkg/index.js", "module.exports = 1;\n");
    write("caf\u00e9/node_modules/pkg/index.js", "module.exports = 1;\n");
    git("config", "core.ignorecase", "true");
    git("config", "core.precomposeunicode", "true");
    git("add", "node_modules/pkg/index.js", "caf\u00e9/node_modules/pkg/index.js");
    git("commit", "-qm", "folding");

    const upperCaseCandidate = join(root, "Node_Modules");
    const nfdCandidate = join(root, "cafe\u0301", "node_modules");
    const expected = {
      tracked: new Set([upperCaseCandidate, nfdCandidate]),
      unknown: new Set<string>(),
      containsGitRepo: new Set<string>(),
    };
    expect(gitTrackedPathsViaGit([upperCaseCandidate, nfdCandidate])).toEqual(expected);
    if (isRustEngineAvailable()) {
      expect(gitTrackedPathsViaEngine([upperCaseCandidate, nfdCandidate])).toEqual(expected);
    }
  });

  test("broken inner .git inside healthy outer repo fails closed via rev-parse toplevel check", () => {
    write("README.md", "outer\n");
    git("add", "README.md");
    git("commit", "-qm", "outer");
    const inner = join(root, "inner");
    const candidate = join(inner, "node_modules");
    mkdirSync(join(inner, ".git"), { recursive: true });
    mkdirSync(candidate, { recursive: true });

    const expected = {
      tracked: new Set<string>(),
      unknown: new Set([candidate]),
      containsGitRepo: new Set<string>(),
    };
    expect(gitTrackedPathsViaGit([candidate])).toEqual(expected);
    if (isRustEngineAvailable()) {
      expect(gitTrackedPathsViaEngine([candidate])).toEqual(expected);
    }
  });

  test("nested candidates dist and dist/cache are both reported tracked", () => {
    write("dist/cache/work.js", "1\n");
    git("add", "dist/cache/work.js");
    git("commit", "-qm", "nested");
    const outerCand = join(root, "dist");
    const innerCand = join(outerCand, "cache");
    const expected = {
      tracked: new Set([outerCand, innerCand]),
      unknown: new Set<string>(),
      containsGitRepo: new Set<string>(),
    };
    expect(gitTrackedPathsViaGit([outerCand, innerCand])).toEqual(expected);
    if (isRustEngineAvailable()) {
      expect(gitTrackedPathsViaEngine([outerCand, innerCand])).toEqual(expected);
    }
  });

  test("bounded nested .git search detects nested repos and marks bound overflow unknown", () => {
    const cand = join(root, "bounded-nm");
    mkdirSync(join(cand, "a", "b", "c"), { recursive: true });
    expect(scanCandidateForDotGit(cand, { maxDirs: 2, maxEntries: 100, maxDepth: 10 })).toBe(
      "unknown",
    );
    expect(scanCandidateForDotGit(cand, { maxDirs: 100, maxEntries: 100, maxDepth: 1 })).toBe(
      "unknown",
    );
    expect(scanCandidateForDotGit(cand, { maxDirs: 100, maxEntries: 100, maxDepth: 10 })).toBe(
      "not_found",
    );
    mkdirSync(join(cand, "a", "b", ".git"), { recursive: true });
    expect(scanCandidateForDotGit(cand, { maxDirs: 100, maxEntries: 100, maxDepth: 10 })).toBe(
      "found",
    );
  });

  test("normalizeWinCanonical normalizes verbatim prefixes, UNC paths, slashes, and case", () => {
    expect(normalizeWinCanonical("\\\\?\\C:\\Users\\RunnerAdmin\\AppData\\Local\\Temp\\repo")).toBe(
      normalizeWinCanonical("c:/users/runneradmin/appdata/local/temp/repo/"),
    );
    expect(normalizeWinCanonical("\\\\?\\UNC\\Server\\Share\\Repo\\")).toBe(
      "\\\\server\\share\\repo",
    );
    expect(normalizeWinCanonical("\\\\?\\unc\\SERVER\\share\\repo")).toBe(
      "\\\\server\\share\\repo",
    );
    expect(normalizeWinCanonical("\\\\?\\C:\\")).toBe("c:\\");
    expect(normalizeWinCanonical("C:/")).toBe("c:\\");
    expect(normalizeWinCanonical("\\\\?\\C:\\repo-a")).not.toBe(
      normalizeWinCanonical("C:\\repo-b"),
    );
  });

  test("repo root identity matches git rev-parse --show-toplevel across aliased spellings and rejects distinct dirs", () => {
    write("dist/vendor.js");
    write("node_modules/pkg/index.js");
    git("add", "dist/vendor.js");
    git("commit", "-qm", "init");

    const toplevelRes = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: gitEnv(),
    });
    expect(toplevelRes.status).toBe(0);
    const toplevel = toplevelRes.stdout.replace(/[\r\n]+$/, "");
    expect(sameRepoRoot(root, toplevel)).toBe(true);

    const other = mkdtempSync(join(tmpdir(), "sweep-distinct-root-"));
    try {
      expect(sameRepoRoot(root, other)).toBe(false);

      if (process.platform !== "win32") {
        const aliasParent = join(other, "link-parent");
        const repoAlias = join(other, "repo-alias");
        symlinkSync(dirname(root), aliasParent);
        symlinkSync(root, repoAlias);

        const viaParentAlias = join(aliasParent, basename(root));
        expect(sameRepoRoot(viaParentAlias, toplevel)).toBe(true);
        expect(sameRepoRoot(repoAlias, toplevel)).toBe(true);

        for (const aliasedRoot of [viaParentAlias, repoAlias]) {
          const aliasedDist = join(aliasedRoot, "dist");
          const aliasedModules = join(aliasedRoot, "node_modules");
          const expected = {
            tracked: new Set([aliasedDist]),
            unknown: new Set<string>(),
            containsGitRepo: new Set<string>(),
          };
          expect(gitTrackedPathsViaGit([aliasedDist, aliasedModules])).toEqual(expected);
          if (isRustEngineAvailable()) {
            expect(gitTrackedPathsViaEngine([aliasedDist, aliasedModules])).toEqual(expected);
          }
        }

        // A genuinely different toplevel (broken inner .git inside the aliased repo) still fails closed.
        const brokenInner = join(repoAlias, "broken-inner");
        const brokenCand = join(brokenInner, "node_modules");
        mkdirSync(join(brokenInner, ".git"), { recursive: true });
        mkdirSync(brokenCand, { recursive: true });
        const expectedUnknown = {
          tracked: new Set<string>(),
          unknown: new Set([brokenCand]),
          containsGitRepo: new Set<string>(),
        };
        expect(gitTrackedPathsViaGit([brokenCand])).toEqual(expectedUnknown);
        if (isRustEngineAvailable()) {
          expect(gitTrackedPathsViaEngine([brokenCand])).toEqual(expectedUnknown);
        }
      } else {
        // On Windows runners, tmpdir() carries an 8.3 short-name segment (e.g. RUNNER~1)
        // while git reports forward-slash long names. Verify both engines agree on both spellings.
        const forwardRoot = root.replaceAll("\\", "/");
        expect(sameRepoRoot(forwardRoot, toplevel)).toBe(true);
        expect(sameRepoRoot(root.toLowerCase(), toplevel.toUpperCase())).toBe(true);
        const dist = join(root, "dist");
        const modules = join(root, "node_modules");
        const expected = {
          tracked: new Set([dist]),
          unknown: new Set<string>(),
          containsGitRepo: new Set<string>(),
        };
        expect(gitTrackedPathsViaGit([dist, modules])).toEqual(expected);
        if (isRustEngineAvailable()) {
          expect(gitTrackedPathsViaEngine([dist, modules])).toEqual(expected);
        }
      }
    } finally {
      rmSync(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("core.worktree pointing elsewhere marks unknown in both engines with and without git", () => {
    const altWorktree = mkdtempSync(join(tmpdir(), "sweep-alt-worktree-"));
    const previousPath = process.env.PATH;
    try {
      write("node_modules/pkg/index.js", "module.exports = 1;\n");
      git("add", "node_modules/pkg/index.js");
      git("commit", "-qm", "init");
      git("config", "core.worktree", altWorktree.replaceAll("\\", "/"));

      const nmPath = join(root, "node_modules");
      const expectedUnknown = {
        tracked: new Set<string>(),
        unknown: new Set([nmPath]),
        containsGitRepo: new Set<string>(),
      };
      // With git on PATH: rev-parse --show-toplevel disagrees with discovered root.
      expect(gitTrackedPathsViaGit([nmPath])).toEqual(expectedUnknown);
      if (isRustEngineAvailable()) {
        expect(gitTrackedPathsViaEngine([nmPath])).toEqual(expectedUnknown);
      }

      // Without git on PATH: both JS and Rust native fallback fail closed as unknown.
      process.env.PATH =
        process.platform === "win32" ? "C:\\nonexistent-sweep-no-git" : "/nonexistent-sweep-no-git";
      expect(gitTrackedPathsViaGit([nmPath])).toEqual(expectedUnknown);
      if (isRustEngineAvailable()) {
        expect(gitTrackedPathsViaEngine([nmPath])).toEqual(expectedUnknown);
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(altWorktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
