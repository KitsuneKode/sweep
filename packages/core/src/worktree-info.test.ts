import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
