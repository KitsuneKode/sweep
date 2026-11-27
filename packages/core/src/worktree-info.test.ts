import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { canonicalPath } from "./git-index.js";
import { GIT_ENV, gitEnv } from "./git-tracked.js";
import { WorktreeIndex } from "./worktree-info.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

function hasInstalledLocale(locale: string): boolean {
  if (process.platform === "win32") return false;
  const out = spawnSync("locale", ["-a"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (out.status !== 0 || typeof out.stdout !== "string") return false;
  const normalized = locale.toLowerCase().replace(/-/g, "");
  return out.stdout
    .split(/\r?\n/)
    .some((line) => line.trim().toLowerCase().replace(/-/g, "") === normalized);
}

const hasGermanLocale = hasInstalledLocale("de_DE.UTF-8");

let root: string;
let repo: string;
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
  env.LC_ALL = "C";
  return env;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: isolatedGitEnv(),
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(cwd: string, file: string, content = `${file}\n`): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "-c", "commit.gpgsign=false", "commit", "-q", "-m", file);
}

beforeEach(() => {
  const rawRoot = mkdtempSync(join(tmpdir(), "sweep-worktree-"));
  root = canonicalPath(rawRoot) ?? rawRoot;
  emptyGitConfig = join(root, ".empty-gitconfig");
  writeFileSync(emptyGitConfig, "");
  repo = join(root, "app");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "readme");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!hasGit)("worktree info", () => {
  test("an ordinary checkout is not a worktree", async () => {
    expect(await new WorktreeIndex().forProject(repo)).toBeUndefined();
  });

  test("a merged branch is finished; an open one is not", async () => {
    const done = join(repo, ".worktrees", "done");
    const open = join(repo, ".worktrees", "open");
    git(repo, "worktree", "add", "-q", "-b", "done", done);
    git(repo, "worktree", "add", "-q", "-b", "open", open);
    commit(done, "feature");
    commit(open, "wip");
    git(repo, "merge", "-q", "--ff-only", "done");

    const index = new WorktreeIndex();
    expect(await index.forProject(done)).toEqual({ of: repo, branch: "done", state: "merged" });
    expect(await index.forProject(open)).toEqual({ of: repo, branch: "open" });
  });

  test("upstream_gone is evaluated before merge classification for both unmerged and merged branches", async () => {
    const remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "-u", "origin", "main");
    git(repo, "remote", "set-head", "origin", "main");

    // Unmerged branch whose remote tracking branch was pruned.
    const unmergedGone = join(root, "unmerged-gone");
    git(repo, "worktree", "add", "-q", "-b", "unmerged-gone", unmergedGone);
    commit(unmergedGone, "unlanded");
    git(unmergedGone, "push", "-q", "-u", "origin", "unmerged-gone");
    git(repo, "push", "-q", "origin", "--delete", "unmerged-gone");

    // Merged branch (no-ff) whose remote tracking branch was ALSO deleted & pruned.
    const mergedGone = join(root, "merged-gone");
    git(repo, "worktree", "add", "-q", "-b", "merged-gone", mergedGone);
    commit(mergedGone, "landed");
    git(mergedGone, "push", "-q", "-u", "origin", "merged-gone");
    git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "merge", "merged-gone");
    git(repo, "push", "-q", "origin", "main");
    git(repo, "push", "-q", "origin", "--delete", "merged-gone");
    git(repo, "fetch", "-q", "--prune");

    const index = new WorktreeIndex();
    expect(await index.forProject(unmergedGone)).toEqual({
      of: repo,
      branch: "unmerged-gone",
      state: "upstream_gone",
    });
    expect(await index.forProject(mergedGone)).toEqual({
      of: repo,
      branch: "merged-gone",
      state: "upstream_gone",
    });
  });

  test("the base branch itself and a detached HEAD are never finished", async () => {
    const side = join(root, "side");
    git(repo, "switch", "-q", "-c", "other");
    git(repo, "worktree", "add", "-q", side, "main");
    expect(await new WorktreeIndex().forProject(side)).toEqual({ of: repo, branch: "main" });

    const detached = join(root, "detached");
    git(repo, "worktree", "add", "-q", "--detach", detached);
    expect(await new WorktreeIndex().forProject(detached)).toEqual({ of: repo });
  });

  test("a submodule-style pointer without commondir is not a worktree", async () => {
    const sub = join(root, "sub");
    const gitDir = join(repo, ".git", "modules", "sub");
    mkdirSync(sub);
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(sub, ".git"), `gitdir: ${gitDir}\n`);
    expect(await new WorktreeIndex().forProject(sub)).toBeUndefined();
  });

  test("git failing leaves the state unknown, and each repository is asked once", async () => {
    const a = join(root, "a");
    const b = join(root, "b");
    git(repo, "worktree", "add", "-q", "-b", "a", a);
    git(repo, "worktree", "add", "-q", "-b", "b", b);
    let calls = 0;
    const index = new WorktreeIndex(() => {
      calls += 1;
      return undefined;
    });
    expect(await index.forProject(a)).toEqual({ of: repo, branch: "a" });
    expect(await index.forProject(b)).toEqual({ of: repo, branch: "b" });
    expect(calls).toBe(1);
  });

  test("zero-commit branches (at base, behind base, or at a merged side commit) never count as merged", async () => {
    const atBase = join(root, "fresh-at-base");
    const behindBase = join(root, "fresh-behind-base");
    git(repo, "worktree", "add", "-q", "-b", "fresh-behind-base", behindBase);
    commit(repo, "advance-main");
    git(repo, "worktree", "add", "-q", "-b", "fresh-at-base", atBase);

    // Side branch merged via --no-ff, then a fresh zero-commit branch forked from that side tip.
    const side = join(root, "side-merged");
    git(repo, "worktree", "add", "-q", "-b", "side-merged", side);
    commit(side, "side-work");
    commit(repo, "main-parallel");
    git(
      repo,
      "-c",
      "commit.gpgsign=false",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "merge side",
      "side-merged",
    );
    const zeroOnSide = join(root, "zero-on-side");
    git(repo, "worktree", "add", "-q", "-b", "zero-on-side", zeroOnSide, "side-merged");

    // Branch that had an own commit, was reset to a merged side tip, and never committed again.
    const resetToSide = join(root, "reset-to-side");
    git(repo, "worktree", "add", "-q", "-b", "reset-to-side", resetToSide);
    commit(resetToSide, "discarded");
    git(resetToSide, "reset", "-q", "--hard", "side-merged");

    // Branch that committed, reset to main, then fast-forwarded to a newer main.
    const resetThenFf = join(root, "reset-then-ff");
    git(repo, "worktree", "add", "-q", "-b", "reset-then-ff", resetThenFf);
    commit(resetThenFf, "discarded-2");
    git(resetThenFf, "reset", "-q", "--hard", "main");
    commit(repo, "advance-main-again");
    git(resetThenFf, "merge", "-q", "--ff-only", "main");

    const index = new WorktreeIndex();
    expect(await index.forProject(side)).toEqual({
      of: repo,
      branch: "side-merged",
      state: "merged",
    });
    expect(await index.forProject(atBase)).toEqual({ of: repo, branch: "fresh-at-base" });
    expect(await index.forProject(behindBase)).toEqual({ of: repo, branch: "fresh-behind-base" });
    expect(await index.forProject(zeroOnSide)).toEqual({ of: repo, branch: "zero-on-side" });
    expect(await index.forProject(resetToSide)).toEqual({ of: repo, branch: "reset-to-side" });
    expect(await index.forProject(resetThenFf)).toEqual({ of: repo, branch: "reset-then-ff" });
  });

  test("a merged branch via merge commit counts as merged when reflogs are missing", async () => {
    const merged = join(root, "merged-noff");
    git(repo, "worktree", "add", "-q", "-b", "merged-noff", merged);
    commit(merged, "side-feature");
    commit(repo, "main-work");
    git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "merge", "merged-noff");
    // Drop reflogs to prove DAG-only merge detection still works when no reflog exists.
    rmSync(join(repo, ".git", "logs"), { recursive: true, force: true });

    expect(await new WorktreeIndex().forProject(merged)).toEqual({
      of: repo,
      branch: "merged-noff",
      state: "merged",
    });
  });

  test("data-only cleanliness rejects modified, staged, untracked, submodule, index-flag, and in-progress states, while honoring .gitignore", async () => {
    commit(repo, ".gitignore", "node_modules/\n*.log\n");

    const cleanWithIgnored = join(root, "clean-ignored");
    const dirtyTracked = join(root, "dirty-tracked");
    const dirtyStaged = join(root, "dirty-staged");
    const dirtyUntracked = join(root, "dirty-untracked");
    const dirtyMergeHead = join(root, "dirty-merge-head");
    const dirtyAssumeUnchanged = join(root, "dirty-assume-unchanged");
    const dirtySkipWorktree = join(root, "dirty-skip-worktree");

    for (const [name, dir] of [
      ["clean-ignored", cleanWithIgnored],
      ["dirty-tracked", dirtyTracked],
      ["dirty-staged", dirtyStaged],
      ["dirty-untracked", dirtyUntracked],
      ["dirty-merge-head", dirtyMergeHead],
      ["dirty-assume-unchanged", dirtyAssumeUnchanged],
      ["dirty-skip-worktree", dirtySkipWorktree],
    ] as const) {
      git(repo, "worktree", "add", "-q", "-b", name, dir);
      commit(dir, `${name}.txt`, "123456\n");
      git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", `m-${name}`, name);
    }

    // Ignored build output inside a clean merged worktree stays clean.
    mkdirSync(join(cleanWithIgnored, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(cleanWithIgnored, "node_modules", "pkg", "index.js"), "module.exports={}\n");
    writeFileSync(join(cleanWithIgnored, "debug.log"), "ok\n");

    // Same-length modification catches racy-git same-second edits via blob hash.
    writeFileSync(join(dirtyTracked, "dirty-tracked.txt"), "654321\n");

    // Staged edit (index matches disk, but index differs from tipOid tree).
    writeFileSync(join(dirtyStaged, "staged.txt"), "staged\n");
    git(dirtyStaged, "add", "staged.txt");

    // Non-ignored untracked file.
    writeFileSync(join(dirtyUntracked, "untracked.txt"), "wip\n");

    // In-progress merge with identical trees (MERGE_HEAD present in worktree gitDir).
    const mergeHeadTip = git(dirtyMergeHead, "rev-parse", "HEAD");
    const mergeGitDir = git(dirtyMergeHead, "rev-parse", "--git-dir");
    writeFileSync(join(mergeGitDir, "MERGE_HEAD"), `${mergeHeadTip}\n`);

    // Suppressing index flags.
    git(dirtyAssumeUnchanged, "update-index", "--assume-unchanged", "dirty-assume-unchanged.txt");
    git(dirtySkipWorktree, "update-index", "--skip-worktree", "dirty-skip-worktree.txt");

    const index = new WorktreeIndex();
    expect(await index.forProject(cleanWithIgnored)).toEqual({
      of: repo,
      branch: "clean-ignored",
      state: "merged",
    });
    expect(await index.forProject(dirtyTracked)).toEqual({ of: repo, branch: "dirty-tracked" });
    expect(await index.forProject(dirtyStaged)).toEqual({ of: repo, branch: "dirty-staged" });
    expect(await index.forProject(dirtyUntracked)).toEqual({ of: repo, branch: "dirty-untracked" });
    expect(await index.forProject(dirtyMergeHead)).toEqual({
      of: repo,
      branch: "dirty-merge-head",
    });
    expect(await index.forProject(dirtyAssumeUnchanged)).toEqual({
      of: repo,
      branch: "dirty-assume-unchanged",
    });
    expect(await index.forProject(dirtySkipWorktree)).toEqual({
      of: repo,
      branch: "dirty-skip-worktree",
    });
  });

  test("dirty submodule (even with submodule.ignore=all) and hostile repo config never run programs or classify as merged", async () => {
    const marker = join(root, "PWNED");
    const subOrigin = join(root, "sub-origin");
    mkdirSync(subOrigin);
    git(subOrigin, "init", "-q", "-b", "main");
    commit(subOrigin, "subfile");

    const wtSub = join(root, "wt-sub");
    git(repo, "worktree", "add", "-q", "-b", "wt-sub", wtSub);
    git(wtSub, "-c", "protocol.file.allow=always", "submodule", "-q", "add", subOrigin, "sub");
    git(wtSub, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "add sub");
    git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "merge sub", "wt-sub");

    const cleanWt = join(root, "wt-clean-hostile");
    git(repo, "worktree", "add", "-q", "-b", "wt-clean-hostile", cleanWt);
    commit(cleanWt, "ok");
    git(
      repo,
      "-c",
      "commit.gpgsign=false",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "merge ok",
      "wt-clean-hostile",
    );

    // Set last: a hostile clone arrives with these already in .git/config.
    writeFileSync(join(wtSub, "sub", "subfile"), "dirty submodule\n");
    git(repo, "config", "submodule.sub.ignore", "all");
    git(repo, "config", "core.fsmonitor", `touch ${marker}`);
    git(repo, "config", "diff.external", `touch ${marker}`);
    expect(existsSync(marker)).toBe(false);

    const index = new WorktreeIndex();
    expect(await index.forProject(wtSub)).toEqual({ of: repo, branch: "wt-sub" });
    // Even wt-clean-hostile contains the submodule gitlink from main, so it stays unknown conservatively.
    expect(await index.forProject(cleanWt)).toEqual({ of: repo, branch: "wt-clean-hostile" });
    expect(existsSync(marker)).toBe(false);
  });

  test("split-index worktree stays unknown and does not modify sharedindex mtime", async () => {
    const wt = join(root, "wt-split");
    git(repo, "worktree", "add", "-q", "-b", "wt-split", wt);
    commit(wt, "split-feat");
    git(repo, "merge", "-q", "--ff-only", "wt-split");
    git(wt, "update-index", "--split-index");

    const wtGitDir = git(wt, "rev-parse", "--git-dir");
    const sharedName = readdirSync(wtGitDir).find((name) => name.startsWith("sharedindex."));
    expect(sharedName).toBeDefined();
    const sharedPath = join(wtGitDir, sharedName!);
    const pinned = new Date("2025-01-01T00:00:00.000Z");
    utimesSync(sharedPath, pinned, pinned);
    const beforeMs = Math.floor(statSync(sharedPath).mtimeMs);

    expect(await new WorktreeIndex().forProject(wt)).toEqual({ of: repo, branch: "wt-split" });
    expect(Math.floor(statSync(sharedPath).mtimeMs)).toBe(beforeMs);
  });

  test("cached ref scan fails closed when another worktree adds an unmerged commit afterward", async () => {
    const wt1 = join(root, "wt1");
    const wt2 = join(root, "wt2");
    git(repo, "worktree", "add", "-q", "-b", "wt1", wt1);
    git(repo, "worktree", "add", "-q", "-b", "wt2", wt2);
    commit(wt1, "f1");
    commit(wt2, "f2");
    git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "m1", "wt1");
    git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "m2", "wt2");

    const index = new WorktreeIndex();
    // Prime repo cache on wt1.
    expect(await index.forProject(wt1)).toEqual({ of: repo, branch: "wt1", state: "merged" });

    // Now add an unmerged commit to wt2 (wt2 remains clean!).
    commit(wt2, "unmerged-after-cache");

    // Must fail closed instead of pairing stale cached merge state with wt2's clean tree.
    expect(await index.forProject(wt2)).toEqual({ of: repo, branch: "wt2" });
  });

  test("base selection uses origin/HEAD, never guesses main/master when origin/HEAD is missing or main worktree is on another branch", async () => {
    // Case 1: origin remote configured (defaulting to develop) with no local origin/HEAD,
    // while feature landed into local `main` only -> base MUST be unknown!
    const remote = join(root, "develop-remote.git");
    git(root, "init", "-q", "--bare", "-b", "develop", remote);
    const repoWithRemote = join(root, "app-remote");
    mkdirSync(repoWithRemote);
    git(repoWithRemote, "init", "-q", "-b", "main");
    commit(repoWithRemote, "init");
    git(repoWithRemote, "remote", "add", "origin", remote);
    git(repoWithRemote, "push", "-q", "origin", "main:develop");
    git(repoWithRemote, "fetch", "-q", "origin");
    // Ensure origin/HEAD is absent.
    const originHeadRef = join(repoWithRemote, ".git", "refs", "remotes", "origin", "HEAD");
    if (existsSync(originHeadRef)) rmSync(originHeadRef);

    const wtRemote = join(root, "wt-remote");
    git(repoWithRemote, "worktree", "add", "-q", "-b", "feat-remote", wtRemote);
    commit(wtRemote, "work");
    git(repoWithRemote, "merge", "-q", "--ff-only", "feat-remote");
    expect(await new WorktreeIndex().forProject(wtRemote)).toEqual({
      of: repoWithRemote,
      branch: "feat-remote",
    });

    // Case 2: local-only repo checked out on `develop` with stale `main`;
    // feature merged only into stale `main` must NOT count as merged.
    const repoDevelop = join(root, "app-develop");
    mkdirSync(repoDevelop);
    git(repoDevelop, "init", "-q", "-b", "main");
    commit(repoDevelop, "base");
    git(repoDevelop, "switch", "-q", "-c", "develop");
    commit(repoDevelop, "develop-only");

    const wtMainOnly = join(root, "wt-main-only");
    git(repoDevelop, "worktree", "add", "-q", "-b", "feat-main", wtMainOnly, "main");
    commit(wtMainOnly, "feat-work");
    // Advance local `main` to include feat-main while main worktree stays on `develop`.
    git(repoDevelop, "branch", "-f", "main", "feat-main");
    expect(await new WorktreeIndex().forProject(wtMainOnly)).toEqual({
      of: repoDevelop,
      branch: "feat-main",
    });

    // Case 3: local-only repo with detached HEAD in main worktree -> unknown base.
    const repoDetached = join(root, "app-detached");
    mkdirSync(repoDetached);
    git(repoDetached, "init", "-q", "-b", "main");
    commit(repoDetached, "base");
    const wtDetachedMain = join(root, "wt-detached-main");
    git(repoDetached, "worktree", "add", "-q", "-b", "feat-det", wtDetachedMain);
    commit(wtDetachedMain, "det-work");
    git(repoDetached, "merge", "-q", "--ff-only", "feat-det");
    git(repoDetached, "checkout", "-q", "--detach", "HEAD");
    expect(await new WorktreeIndex().forProject(wtDetachedMain)).toEqual({
      of: repoDetached,
      branch: "feat-det",
    });
  });

  test.skipIf(process.platform === "win32")(
    "relative gitdir pointer accessed via a symlinked worktree directory resolves canonically",
    async () => {
      const wt = join(root, "wt-rel");
      git(repo, "worktree", "add", "-q", "-b", "wt-rel", wt);
      commit(wt, "rel-feat");
      git(repo, "merge", "-q", "--ff-only", "wt-rel");

      // Rewrite `.git` as a relative gitdir pointer.
      const realGitDir = git(wt, "rev-parse", "--git-dir");
      const relGitDir = relative(wt, realGitDir);
      writeFileSync(join(wt, ".git"), `gitdir: ${relGitDir}\n`);

      // Access the worktree through a symlink located in a different directory.
      const aliasParent = join(root, "nested", "alias-dir");
      mkdirSync(aliasParent, { recursive: true });
      const alias = join(aliasParent, "wt-link");
      symlinkSync(wt, alias, "dir");

      expect(await new WorktreeIndex().forProject(alias)).toEqual({
        of: repo,
        branch: "wt-rel",
        state: "merged",
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "symlinked reflog directory or file under logs/refs/heads is rejected",
    async () => {
      const wt = join(root, "wt-sym-reflog");
      git(repo, "worktree", "add", "-q", "-b", "feat/sym", wt);
      commit(wt, "work");
      git(repo, "merge", "-q", "--ff-only", "feat/sym");

      // Move real reflog directory outside logs/refs/heads and replace with a symlink.
      const externalLogs = join(root, "external-logs");
      mkdirSync(externalLogs, { recursive: true });
      const realHeadDir = join(repo, ".git", "logs", "refs", "heads", "feat");
      const realLog = join(realHeadDir, "sym");
      const movedLog = join(externalLogs, "sym");
      writeFileSync(movedLog, readFileSync(realLog));
      rmSync(realHeadDir, { recursive: true, force: true });
      symlinkSync(externalLogs, realHeadDir, "dir");

      expect(await new WorktreeIndex().forProject(wt)).toEqual({
        of: repo,
        branch: "feat/sym",
      });
    },
  );

  test("gitEnv forces C locale and drops inherited GIT_* overrides", () => {
    expect(GIT_ENV.LC_ALL).toBe("C");
    expect(GIT_ENV.LANG).toBe("C");
    const env = gitEnv({ PATH: "/usr/bin", GIT_DIR: "/wrong", GIT_WORK_TREE: "/wrong" });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_NO_LAZY_FETCH).toBe("1");
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe("1");
  });

  test.skipIf(!hasGermanLocale)(
    "non-English locale env still detects upstream_gone because gitEnv forces C locale",
    async () => {
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
        expect(await new WorktreeIndex().forProject(wt)).toEqual({
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
    },
  );

  test("spending the per-scan time budget leaves remaining repos unknown without spawning git", async () => {
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
        if (gitDir.includes("app2")) callsForRepo2 += 1;
        const result = spawnSync("git", [`--git-dir=${gitDir}`, ...args], {
          encoding: "utf8",
          env: GIT_ENV,
        });
        clock += 200;
        return result.status === 0 ? result.stdout : undefined;
      },
      { budgetMs: 500, now: () => clock },
    );

    expect(await index.forProject(wt1)).toEqual({ of: repo, branch: "wt1", state: "merged" });
    expect(await index.forProject(wt2)).toEqual({ of: repo2, branch: "wt2" });
    expect(callsForRepo2).toBe(0);
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((t) => t <= 500)).toBe(true);
  });

  test.skipIf(process.platform === "win32")(
    "production async runner enforces monotonic deadline and cancellation with a slow fake git",
    async () => {
      const wt = join(root, "wt-slow");
      git(repo, "worktree", "add", "-q", "-b", "wt-slow", wt);
      commit(wt, "work");
      git(repo, "merge", "-q", "--ff-only", "wt-slow");

      const fakeGit = join(root, "slow-git.sh");
      writeFileSync(fakeGit, "#!/bin/sh\nsleep 10\nexit 0\n");
      chmodSync(fakeGit, 0o755);

      // 1. Deadline expiry kills the slow subprocess within bounded time.
      const startBudget = performance.now();
      const budgetIndex = new WorktreeIndex(undefined, {
        budgetMs: 200,
        gitBinary: fakeGit,
      });
      const budgetResult = await budgetIndex.forProject(wt);
      const budgetElapsed = performance.now() - startBudget;
      expect(budgetResult).toEqual({ of: repo, branch: "wt-slow" });
      expect(budgetElapsed).toBeLessThan(1500);

      // 2. AbortSignal cancels the slow subprocess immediately.
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 120);
      const startAbort = performance.now();
      const abortIndex = new WorktreeIndex(undefined, {
        budgetMs: 5_000,
        signal: controller.signal,
        gitBinary: fakeGit,
      });
      const abortResult = await abortIndex.forProject(wt);
      clearTimeout(abortTimer);
      const abortElapsed = performance.now() - startAbort;
      expect(abortResult).toEqual({ of: repo, branch: "wt-slow" });
      expect(abortElapsed).toBeLessThan(1500);
    },
  );
});
