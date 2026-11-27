import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_ENV } from "./git-tracked.js";
import { WorktreeIndex } from "./worktree-info.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

let root: string;
let repo: string;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function commit(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), `${file}\n`);
  git(cwd, "add", file);
  git(cwd, "-c", "commit.gpgsign=false", "commit", "-q", "-m", file);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sweep-worktree-")));
  repo = join(root, "app");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "readme");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!hasGit)("worktree info", () => {
  test("an ordinary checkout is not a worktree", () => {
    expect(new WorktreeIndex().forProject(repo)).toBeUndefined();
  });

  test("a merged branch is finished; an open one is not", () => {
    const done = join(repo, ".worktrees", "done");
    const open = join(repo, ".worktrees", "open");
    git(repo, "worktree", "add", "-q", "-b", "done", done);
    git(repo, "worktree", "add", "-q", "-b", "open", open);
    commit(done, "feature");
    commit(open, "wip");
    git(repo, "merge", "-q", "--ff-only", "done");

    const index = new WorktreeIndex();
    expect(index.forProject(done)).toEqual({ of: repo, branch: "done", state: "merged" });
    expect(index.forProject(open)).toEqual({ of: repo, branch: "open" });
  });

  test("a branch whose remote was deleted reads as upstream_gone", () => {
    const remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "-u", "origin", "main");
    git(repo, "remote", "set-head", "origin", "main");

    const squashed = join(root, "squashed");
    git(repo, "worktree", "add", "-q", "-b", "squashed", squashed);
    commit(squashed, "change");
    git(squashed, "push", "-q", "-u", "origin", "squashed");
    // The pull request is squash-merged and its branch deleted on the remote.
    git(repo, "push", "-q", "origin", "--delete", "squashed");
    git(repo, "fetch", "-q", "--prune");

    expect(new WorktreeIndex().forProject(squashed)).toEqual({
      of: repo,
      branch: "squashed",
      state: "upstream_gone",
    });
  });

  test("the base branch itself and a detached HEAD are never finished", () => {
    const side = join(root, "side");
    git(repo, "switch", "-q", "-c", "other");
    git(repo, "worktree", "add", "-q", side, "main");
    expect(new WorktreeIndex().forProject(side)).toEqual({ of: repo, branch: "main" });

    const detached = join(root, "detached");
    git(repo, "worktree", "add", "-q", "--detach", detached);
    expect(new WorktreeIndex().forProject(detached)).toEqual({ of: repo });
  });

  test("a submodule-style pointer without commondir is not a worktree", () => {
    const sub = join(root, "sub");
    const gitDir = join(repo, ".git", "modules", "sub");
    mkdirSync(sub);
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(sub, ".git"), `gitdir: ${gitDir}\n`);
    expect(new WorktreeIndex().forProject(sub)).toBeUndefined();
  });

  test("git failing leaves the state unknown, and each repository is asked once", () => {
    const a = join(root, "a");
    const b = join(root, "b");
    git(repo, "worktree", "add", "-q", "-b", "a", a);
    git(repo, "worktree", "add", "-q", "-b", "b", b);
    let calls = 0;
    const index = new WorktreeIndex(() => {
      calls += 1;
      return undefined;
    });
    expect(index.forProject(a)).toEqual({ of: repo, branch: "a" });
    expect(index.forProject(b)).toEqual({ of: repo, branch: "b" });
    expect(calls).toBe(1);
  });

  test("an unmerged branch with a gone upstream reads as upstream_gone, never merged", () => {
    const remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "-u", "origin", "main");
    git(repo, "remote", "set-head", "origin", "main");

    const unmerged = join(root, "unmerged-gone");
    git(repo, "worktree", "add", "-q", "-b", "unmerged-gone", unmerged);
    commit(unmerged, "unlanded");
    git(unmerged, "push", "-q", "-u", "origin", "unmerged-gone");
    git(repo, "push", "-q", "origin", "--delete", "unmerged-gone");
    git(repo, "fetch", "-q", "--prune");

    const info = new WorktreeIndex().forProject(unmerged);
    expect(info).toEqual({ of: repo, branch: "unmerged-gone", state: "upstream_gone" });
    expect(info?.state).not.toBe("merged");
  });

  test("a zero-commit branch at or behind the base does not count as merged", () => {
    const atBase = join(root, "fresh-at-base");
    const behindBase = join(root, "fresh-behind-base");
    git(repo, "worktree", "add", "-q", "-b", "fresh-behind-base", behindBase);
    commit(repo, "advance-main");
    git(repo, "worktree", "add", "-q", "-b", "fresh-at-base", atBase);

    const index = new WorktreeIndex();
    expect(index.forProject(atBase)).toEqual({ of: repo, branch: "fresh-at-base" });
    expect(index.forProject(behindBase)).toEqual({ of: repo, branch: "fresh-behind-base" });
  });

  test("a merged branch via merge commit counts as merged even without reflogs", () => {
    const merged = join(root, "merged-noff");
    git(repo, "worktree", "add", "-q", "-b", "merged-noff", merged);
    commit(merged, "side-feature");
    commit(repo, "main-work");
    git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "merge", "merged-noff");
    // Drop reflogs to prove DAG-only merge detection still works.
    rmSync(join(repo, ".git", "logs"), { recursive: true, force: true });

    expect(new WorktreeIndex().forProject(merged)).toEqual({
      of: repo,
      branch: "merged-noff",
      state: "merged",
    });
  });

  test("a dirty worktree on a merged branch never counts as merged", () => {
    const dirtyTracked = join(root, "dirty-tracked");
    const dirtyUntracked = join(root, "dirty-untracked");
    git(repo, "worktree", "add", "-q", "-b", "dirty-tracked", dirtyTracked);
    git(repo, "worktree", "add", "-q", "-b", "dirty-untracked", dirtyUntracked);
    commit(dirtyTracked, "feat-a");
    commit(dirtyUntracked, "feat-b");
    git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "m1", "dirty-tracked");
    git(
      repo,
      "-c",
      "commit.gpgsign=false",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "m2",
      "dirty-untracked",
    );

    writeFileSync(join(dirtyTracked, "feat-a"), "uncommitted edit\n");
    writeFileSync(join(dirtyUntracked, "untracked.txt"), "wip\n");

    const index = new WorktreeIndex();
    expect(index.forProject(dirtyTracked)).toEqual({ of: repo, branch: "dirty-tracked" });
    expect(index.forProject(dirtyUntracked)).toEqual({ of: repo, branch: "dirty-untracked" });
  });

  test("a repository with no verified base leaves worktree state unknown", () => {
    const customRepo = join(root, "custom-base");
    mkdirSync(customRepo);
    git(customRepo, "init", "-q", "-b", "develop");
    commit(customRepo, "base");

    const wt = join(root, "custom-wt");
    git(customRepo, "worktree", "add", "-q", "-b", "feat", wt);
    commit(wt, "work");
    git(customRepo, "merge", "-q", "--ff-only", "feat");

    expect(new WorktreeIndex().forProject(wt)).toEqual({ of: customRepo, branch: "feat" });
  });

  test("non-English locale env still detects upstream_gone because GIT_ENV forces C locale", () => {
    expect(GIT_ENV.LC_ALL).toBe("C");
    expect(GIT_ENV.LANG).toBe("C");

    const remote = join(root, "locale-remote.git");
    git(root, "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "-u", "origin", "main");
    git(repo, "remote", "set-head", "origin", "main");

    const wt = join(root, "locale-wt");
    git(repo, "worktree", "add", "-q", "-b", "locale-wt", wt);
    commit(wt, "change");
    git(wt, "push", "-q", "-u", "origin", "locale-wt");
    git(repo, "push", "-q", "origin", "--delete", "locale-wt");
    git(repo, "fetch", "-q", "--prune");

    const prevLcAll = process.env.LC_ALL;
    const prevLang = process.env.LANG;
    const prevLanguage = process.env.LANGUAGE;
    process.env.LC_ALL = "de_DE.UTF-8";
    process.env.LANG = "de_DE.UTF-8";
    process.env.LANGUAGE = "de_DE:de";
    try {
      expect(new WorktreeIndex().forProject(wt)).toEqual({
        of: repo,
        branch: "locale-wt",
        state: "upstream_gone",
      });
    } finally {
      if (prevLcAll === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = prevLcAll;
      if (prevLang === undefined) delete process.env.LANG;
      else process.env.LANG = prevLang;
      if (prevLanguage === undefined) delete process.env.LANGUAGE;
      else process.env.LANGUAGE = prevLanguage;
    }
  });

  test("spending the per-scan time budget leaves remaining repos unknown without spawning git", () => {
    const repo2 = join(root, "app2");
    mkdirSync(repo2);
    git(repo2, "init", "-q", "-b", "main");
    commit(repo2, "readme");

    const wt1 = join(root, "wt1");
    const wt2 = join(root, "wt2");
    git(repo, "worktree", "add", "-q", "-b", "wt1", wt1);
    commit(wt1, "f1");
    git(repo, "merge", "-q", "--ff-only", "wt1");

    git(repo2, "worktree", "add", "-q", "-b", "wt2", wt2);
    commit(wt2, "f2");
    git(repo2, "merge", "-q", "--ff-only", "wt2");

    let clock = 0;
    let callsForRepo2 = 0;
    const timeouts: number[] = [];
    const index = new WorktreeIndex(
      (gitDir, args, opts) => {
        if (opts?.timeoutMs !== undefined) timeouts.push(opts.timeoutMs);
        if (gitDir.includes("app2") || opts?.cwd === wt2) callsForRepo2 += 1;
        const result = spawnSync(
          "git",
          opts?.cwd ? ["-C", opts.cwd, ...args] : [`--git-dir=${gitDir}`, ...args],
          { encoding: "utf8", env: GIT_ENV },
        );
        // Simulate repo 1 consuming the entire 500 ms scan budget.
        clock += 200;
        return result.status === 0 ? result.stdout : undefined;
      },
      { budgetMs: 500, now: () => clock },
    );

    expect(index.forProject(wt1)).toEqual({ of: repo, branch: "wt1", state: "merged" });
    // Budget is now spent (>= 500ms); repo2 must not spawn git and must stay unknown.
    expect(index.forProject(wt2)).toEqual({ of: repo2, branch: "wt2" });
    expect(callsForRepo2).toBe(0);
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((t) => t <= 500)).toBe(true);
  });
});
