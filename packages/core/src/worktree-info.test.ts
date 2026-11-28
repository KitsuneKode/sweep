import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  type BigIntStats,
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

/**
 * Make tracked file mtimes strictly older than the worktree index mtime
 * (matching a normal settled checkout rather than a same-second racily-clean entry).
 */
function settleWorktree(wt: string): void {
  const past = new Date(Date.now() - 5_000);
  const tracked = git(wt, "ls-files")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  for (const rel of tracked) {
    const abs = join(wt, rel);
    try {
      if (!lstatSync(abs).isSymbolicLink()) utimesSync(abs, past, past);
    } catch {
      // Ignore missing or unreadable entries.
    }
  }
  git(wt, "update-index", "--refresh");
}

/**
 * Rewrite cached stat timestamps for `targetPath` inside a SHA-1 v2/v3
 * `.git/index` and recompute its trailing SHA-1 checksum (simulating a
 * coarse-clock filesystem index entry without requiring FUSE).
 */
function patchIndexEntryStat(
  indexPath: string,
  targetPath: string,
  patch: { mtimeSec?: number; mtimeNsec?: number; ctimeSec?: number; ctimeNsec?: number },
): void {
  const buf = Buffer.from(readFileSync(indexPath));
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`unexpected index version ${version}`);
  }
  const count = buf.readUInt32BE(8);
  let at = 12;
  let found = false;
  for (let i = 0; i < count; i++) {
    const start = at;
    const flags = buf.readUInt16BE(start + 60);
    const extended = (flags & 0x4000) !== 0;
    const nameStart = start + 62 + (extended ? 2 : 0);
    const nul = buf.indexOf(0, nameStart);
    if (nul < 0) throw new Error("unterminated index path");
    const entryPath = buf.subarray(nameStart, nul).toString("utf8");
    if (entryPath === targetPath) {
      if (patch.ctimeSec !== undefined) buf.writeUInt32BE(patch.ctimeSec >>> 0, start);
      if (patch.ctimeNsec !== undefined) buf.writeUInt32BE(patch.ctimeNsec >>> 0, start + 4);
      if (patch.mtimeSec !== undefined) buf.writeUInt32BE(patch.mtimeSec >>> 0, start + 8);
      if (patch.mtimeNsec !== undefined) buf.writeUInt32BE(patch.mtimeNsec >>> 0, start + 12);
      found = true;
    }
    const fixed = nameStart - start;
    const nameLen = nul - nameStart;
    at = start + ((fixed + nameLen + 8) & ~7);
  }
  if (!found) throw new Error(`entry ${targetPath} not found in ${indexPath}`);
  const payloadEnd = buf.length - 20;
  const sha1 = createHash("sha1").update(buf.subarray(0, payloadEnd)).digest();
  sha1.copy(buf, payloadEnd);
  writeFileSync(indexPath, buf);
}

beforeEach(() => {
  const rawRoot = mkdtempSync(join(tmpdir(), "sweep-worktree-"));
  root = canonicalPath(rawRoot) ?? rawRoot;
  emptyGitConfig = join(root, ".empty-gitconfig");
  writeFileSync(emptyGitConfig, "");
  repo = join(root, "app");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
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
    settleWorktree(done);
    commit(open, "wip");
    settleWorktree(open);
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
    settleWorktree(side);
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
    settleWorktree(zeroOnSide);

    // Branch that had an own commit, was reset to a merged side tip, and never committed again.
    const resetToSide = join(root, "reset-to-side");
    git(repo, "worktree", "add", "-q", "-b", "reset-to-side", resetToSide);
    commit(resetToSide, "discarded");
    git(resetToSide, "reset", "-q", "--hard", "side-merged");
    settleWorktree(resetToSide);

    // Branch that committed, reset to main, then fast-forwarded to a newer main.
    const resetThenFf = join(root, "reset-then-ff");
    git(repo, "worktree", "add", "-q", "-b", "reset-then-ff", resetThenFf);
    commit(resetThenFf, "discarded-2");
    git(resetThenFf, "reset", "-q", "--hard", "main");
    commit(repo, "advance-main-again");
    git(resetThenFf, "merge", "-q", "--ff-only", "main");
    settleWorktree(resetThenFf);

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

  test("a merged branch without a reflog stays unknown (no first-parent fallback)", async () => {
    const merged = join(root, "merged-noff");
    git(repo, "worktree", "add", "-q", "-b", "merged-noff", merged);
    commit(merged, "side-feature");
    settleWorktree(merged);
    commit(repo, "main-work");
    git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "merge", "merged-noff");
    rmSync(join(repo, ".git", "logs"), { recursive: true, force: true });

    expect(await new WorktreeIndex().forProject(merged)).toEqual({
      of: repo,
      branch: "merged-noff",
    });
  });

  test("cleanliness rejects modified, racily-clean, staged, untracked, submodule, index-flag, and in-progress states, while honoring .gitignore", async () => {
    commit(repo, ".gitignore", "node_modules/\n*.log\n");

    const cleanWithIgnored = join(root, "clean-ignored");
    const racilyClean = join(root, "racily-clean");
    const dirtyTracked = join(root, "dirty-tracked");
    const dirtyStaged = join(root, "dirty-staged");
    const dirtyUntracked = join(root, "dirty-untracked");
    const dirtyMergeHead = join(root, "dirty-merge-head");
    const dirtyAssumeUnchanged = join(root, "dirty-assume-unchanged");
    const dirtySkipWorktree = join(root, "dirty-skip-worktree");

    for (const [name, dir] of [
      ["clean-ignored", cleanWithIgnored],
      ["racily-clean", racilyClean],
      ["dirty-tracked", dirtyTracked],
      ["dirty-staged", dirtyStaged],
      ["dirty-untracked", dirtyUntracked],
      ["dirty-merge-head", dirtyMergeHead],
      ["dirty-assume-unchanged", dirtyAssumeUnchanged],
      ["dirty-skip-worktree", dirtySkipWorktree],
    ] as const) {
      git(repo, "worktree", "add", "-q", "-b", name, dir);
      commit(dir, `${name}.txt`, "123456\n");
      if (name !== "racily-clean") settleWorktree(dir);
      git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", `m-${name}`, name);
    }

    // Ignored build output inside a clean merged worktree stays clean.
    mkdirSync(join(cleanWithIgnored, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(cleanWithIgnored, "node_modules", "pkg", "index.js"), "module.exports={}\n");
    writeFileSync(join(cleanWithIgnored, "debug.log"), "ok\n");

    const racilyGitDir = git(racilyClean, "rev-parse", "--git-dir");
    const racilyMtimeSec = Number(
      lstatSync(join(racilyClean, "racily-clean.txt"), { bigint: true }).mtimeNs / 1_000_000_000n,
    );
    const racilyMtime = new Date(racilyMtimeSec * 1000);
    utimesSync(join(racilyGitDir, "index"), racilyMtime, racilyMtime);

    // Same-length modification catches edits via stat mismatch.
    writeFileSync(join(dirtyTracked, "dirty-tracked.txt"), "654321\n");

    // Staged edit (index matches disk, but index differs from tipOid tree).
    writeFileSync(join(dirtyStaged, "staged.txt"), "staged\n");
    git(dirtyStaged, "add", "staged.txt");
    settleWorktree(dirtyStaged);

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
    expect(await index.forProject(racilyClean)).toEqual({ of: repo, branch: "racily-clean" });
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
    settleWorktree(wt1);
    commit(wt2, "f2");
    settleWorktree(wt2);
    git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "m1", "wt1");
    git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "m2", "wt2");

    const index = new WorktreeIndex();
    // Prime repo cache on wt1.
    expect(await index.forProject(wt1)).toEqual({ of: repo, branch: "wt1", state: "merged" });

    // Now add an unmerged commit to wt2 (wt2 remains clean!).
    commit(wt2, "unmerged-after-cache");
    settleWorktree(wt2);

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
      settleWorktree(wt);
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
    git(repo2, "config", "core.autocrlf", "false");
    commit(repo2, "readme");

    const wt1 = join(root, "wt1");
    const wt2 = join(root, "wt2");
    git(repo, "worktree", "add", "-q", "-b", "wt1", wt1);
    commit(wt1, "f1");
    settleWorktree(wt1);
    git(repo, "merge", "-q", "--ff-only", "wt1");

    git(repo2, "worktree", "add", "-q", "-b", "wt2", wt2);
    commit(wt2, "f2");
    settleWorktree(wt2);
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
          ...(opts?.stdin !== undefined ? { input: opts.stdin } : {}),
        });
        clock += 50;
        return result.status === 0 ? result.stdout : undefined;
      },
      { budgetMs: 600, now: () => clock },
    );

    expect(await index.forProject(wt1)).toEqual({ of: repo, branch: "wt1", state: "merged" });
    // Advance past deadline before checking repo2 so filesystem and git work stop immediately.
    clock = 700;
    expect(await index.forProject(wt2)).toEqual({ of: repo2, branch: "wt2" });
    expect(callsForRepo2).toBe(0);
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((t) => t <= 600)).toBe(true);
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

  test("ignore matching delegates to git so embedded **, escaped wildcards, unclosed classes, case-insensitive negation, and reversed ranges match git", async () => {
    const wtDoubleStar = join(root, "wt-double-star");
    const wtEscaped = join(root, "wt-escaped-wild");
    const wtUnclosed = join(root, "wt-unclosed-class");
    const wtCaseNeg = join(root, "wt-case-neg");
    const wtReversed = join(root, "wt-reversed-range");

    for (const [wtDir, gitignore, setup] of [
      [
        wtDoubleStar,
        "out/file**.log\ndocs/**.md\n",
        (d: string) => {
          mkdirSync(join(d, "out", "files"), { recursive: true });
          writeFileSync(join(d, "out", "files", "debug.log"), "untracked\n");
          mkdirSync(join(d, "docs", "sub"), { recursive: true });
          writeFileSync(join(d, "docs", "sub", "a.md"), "untracked\n");
        },
      ],
      [
        wtEscaped,
        "literal\\*.txt\n",
        (d: string) => writeFileSync(join(d, "literal.txt"), "untracked\n"),
      ],
      [wtUnclosed, "[abc\n", (d: string) => writeFileSync(join(d, "[abc"), "untracked\n")],
      [
        wtCaseNeg,
        "*\n!README.md\n*.tmp\n!KEEP.tmp\n",
        (d: string) => {
          git(repo, "config", "core.ignorecase", "true");
          writeFileSync(join(d, "readme.md"), "untracked\n");
          writeFileSync(join(d, "keep.tmp"), "untracked\n");
        },
      ],
      [
        wtReversed,
        "[z-a]\n",
        (d: string) => writeFileSync(join(d, "untracked.txt"), "untracked\n"),
      ],
    ] as const) {
      const name = wtDir.split(/[\\/]/).pop()!;
      git(repo, "worktree", "add", "-q", "-b", name, wtDir);
      commit(wtDir, ".gitignore", gitignore);
      settleWorktree(wtDir);
      git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", `m-${name}`, name);
      setup(wtDir);
    }

    const index = new WorktreeIndex();
    expect(await index.forProject(wtDoubleStar)).toEqual({ of: repo, branch: "wt-double-star" });
    expect(await index.forProject(wtEscaped)).toEqual({ of: repo, branch: "wt-escaped-wild" });
    expect(await index.forProject(wtUnclosed)).toEqual({ of: repo, branch: "wt-unclosed-class" });
    expect(await index.forProject(wtCaseNeg)).toEqual({ of: repo, branch: "wt-case-neg" });
    expect(await index.forProject(wtReversed)).toEqual({ of: repo, branch: "wt-reversed-range" });
  });

  test("reflogs disabled leaves both merged branches and fresh side-tip branches unknown", async () => {
    const noReflogRepo = join(root, "app-no-reflog");
    mkdirSync(noReflogRepo);
    git(noReflogRepo, "init", "-q", "-b", "main");
    git(noReflogRepo, "config", "core.autocrlf", "false");
    git(noReflogRepo, "config", "core.logAllRefUpdates", "false");
    commit(noReflogRepo, "init");

    const side = join(root, "wt-side-noreflog");
    git(noReflogRepo, "worktree", "add", "-q", "-b", "side-noreflog", side);
    commit(side, "work");
    settleWorktree(side);
    commit(noReflogRepo, "main-parallel");
    git(
      noReflogRepo,
      "-c",
      "commit.gpgsign=false",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "merge side",
      "side-noreflog",
    );

    const freshOnSide = join(root, "wt-fresh-on-side-noreflog");
    git(
      noReflogRepo,
      "worktree",
      "add",
      "-q",
      "-b",
      "fresh-noreflog",
      freshOnSide,
      "side-noreflog",
    );
    settleWorktree(freshOnSide);

    const index = new WorktreeIndex();
    expect(await index.forProject(side)).toEqual({ of: noReflogRepo, branch: "side-noreflog" });
    expect(await index.forProject(freshOnSide)).toEqual({
      of: noReflogRepo,
      branch: "fresh-noreflog",
    });
  });

  test("included origin config and case-variant remote section without origin/HEAD leave base unknown", async () => {
    // 1. Included origin config
    const incRepo = join(root, "app-inc-origin");
    mkdirSync(incRepo);
    git(incRepo, "init", "-q", "-b", "main");
    git(incRepo, "config", "core.autocrlf", "false");
    commit(incRepo, "init");
    const incFile = join(root, "origin-inc.gitconfig");
    writeFileSync(incFile, '[remote "origin"]\n\turl = /nonexistent/remote.git\n');
    git(incRepo, "config", "include.path", incFile);

    const wtInc = join(root, "wt-inc-origin");
    git(incRepo, "worktree", "add", "-q", "-b", "feat-inc", wtInc);
    commit(wtInc, "work");
    settleWorktree(wtInc);
    git(incRepo, "merge", "-q", "--ff-only", "feat-inc");

    // 2. Case-variant remote section (`[REMOTE "origin"]`)
    const caseRepo = join(root, "app-case-origin");
    mkdirSync(caseRepo);
    git(caseRepo, "init", "-q", "-b", "main");
    git(caseRepo, "config", "core.autocrlf", "false");
    commit(caseRepo, "init");
    const cfgPath = join(caseRepo, ".git", "config");
    writeFileSync(
      cfgPath,
      `${readFileSync(cfgPath, "utf8")}\n[REMOTE "origin"]\n\turl = /nonexistent/remote.git\n`,
    );

    const wtCase = join(root, "wt-case-origin");
    git(caseRepo, "worktree", "add", "-q", "-b", "feat-case", wtCase);
    commit(wtCase, "work");
    settleWorktree(wtCase);
    git(caseRepo, "merge", "-q", "--ff-only", "feat-case");

    expect(await new WorktreeIndex().forProject(wtInc)).toEqual({
      of: incRepo,
      branch: "feat-inc",
    });
    expect(await new WorktreeIndex().forProject(wtCase)).toEqual({
      of: caseRepo,
      branch: "feat-case",
    });
  });

  test("EOL conversions (autocrlf, core.eol, text, eol) allow settled stat-matching merged worktrees while rejecting edits, racily-clean, filter, and working-tree-encoding", async () => {
    // 1. CRLF checkout with core.autocrlf=true:
    //    - settled, non-racy, stat-matching merged tree -> merged
    //    - same tree with one modified file -> unknown
    //    - same tree racily-clean (same-second mtime) -> unknown
    const crlfRepo = join(root, "app-crlf");
    mkdirSync(crlfRepo);
    git(crlfRepo, "init", "-q", "-b", "main");
    git(crlfRepo, "config", "core.autocrlf", "true");
    commit(crlfRepo, "init", "hello\r\n");

    const wtCrlfClean = join(root, "wt-crlf");
    git(crlfRepo, "worktree", "add", "-q", "-b", "feat-crlf", wtCrlfClean);
    commit(wtCrlfClean, "data.txt", "line1\r\nline2\r\n");
    settleWorktree(wtCrlfClean);
    git(crlfRepo, "merge", "-q", "--ff-only", "feat-crlf");

    const wtCrlfModified = join(root, "wt-crlf-modified");
    git(crlfRepo, "worktree", "add", "-q", "-b", "feat-crlf-mod", wtCrlfModified);
    commit(wtCrlfModified, "mod.txt", "line1\r\nline2\r\n");
    settleWorktree(wtCrlfModified);
    git(crlfRepo, "merge", "-q", "--ff-only", "feat-crlf-mod");
    // Modify one tracked file in the CRLF checkout (same length, different content + newer mtime).
    writeFileSync(join(wtCrlfModified, "mod.txt"), "line1\r\nLINE2\r\n");

    const wtCrlfRacy = join(root, "wt-crlf-racy");
    git(crlfRepo, "worktree", "add", "-q", "-b", "feat-crlf-racy", wtCrlfRacy);
    commit(wtCrlfRacy, "racy.txt", "line1\r\nline2\r\n");
    // Pin index mtime to the entry's mtime so the entry is deterministically racily clean (same-second).
    const racyGitDir = git(wtCrlfRacy, "rev-parse", "--git-dir");
    const racyStat = lstatSync(join(wtCrlfRacy, "racy.txt"));
    utimesSync(join(racyGitDir, "index"), racyStat.atime, racyStat.mtime);
    git(crlfRepo, "merge", "-q", "--ff-only", "feat-crlf-racy");

    // 2. Required clean filter (must NOT execute the filter program!) -> unknown
    const filterMarker = join(root, "FILTER_RAN");
    const filterRepo = join(root, "app-filter");
    mkdirSync(filterRepo);
    git(filterRepo, "init", "-q", "-b", "main");
    git(filterRepo, "config", "core.autocrlf", "false");
    commit(filterRepo, "init");
    const wtFilter = join(root, "wt-filter");
    git(filterRepo, "worktree", "add", "-q", "-b", "feat-filter", wtFilter);
    commit(wtFilter, ".gitattributes", "*.dat filter=myclean\n");
    commit(wtFilter, "item.dat", "raw\n");
    settleWorktree(wtFilter);
    git(filterRepo, "merge", "-q", "--ff-only", "feat-filter");
    git(filterRepo, "config", "filter.myclean.required", "true");
    git(filterRepo, "config", "filter.myclean.clean", `touch ${filterMarker}`);

    // 3. core.eol set -> settled, non-racy, stat-matching merged tree -> merged
    const eolRepo = join(root, "app-core-eol");
    mkdirSync(eolRepo);
    git(eolRepo, "init", "-q", "-b", "main");
    git(eolRepo, "config", "core.autocrlf", "false");
    git(eolRepo, "config", "core.eol", "lf");
    commit(eolRepo, "init");
    const wtCoreEol = join(root, "wt-core-eol");
    git(eolRepo, "worktree", "add", "-q", "-b", "feat-core-eol", wtCoreEol);
    commit(wtCoreEol, "a.txt");
    settleWorktree(wtCoreEol);
    git(eolRepo, "merge", "-q", "--ff-only", "feat-core-eol");

    // 4. text=auto and eol=crlf -> merged when settled; working-tree-encoding -> unknown
    const wtText = join(root, "wt-attr-text");
    const wtEol = join(root, "wt-attr-eol");
    const wtEnc = join(root, "wt-attr-enc");
    const baseTip = git(repo, "rev-parse", "main");
    for (const [name, dir, attrs, file, content] of [
      ["wt-attr-text", wtText, "*.textattr text=auto\n", "a.textattr", "ok\n"],
      ["wt-attr-eol", wtEol, "*.eolattr eol=crlf\n", "a.eolattr", "ok\r\n"],
      [
        "wt-attr-enc",
        wtEnc,
        "*.encattr working-tree-encoding=UTF-16LE-BOM\n",
        "a.encattr",
        "\ufeffok\n",
      ],
    ] as const) {
      git(repo, "worktree", "add", "-q", "-b", name, dir, baseTip);
      commit(dir, ".gitattributes", attrs);
      if (name === "wt-attr-enc") {
        writeFileSync(join(dir, file), Buffer.from(content, "utf16le"));
        git(dir, "add", file);
        git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", file);
      } else {
        commit(dir, file, content);
      }
      settleWorktree(dir);
      git(
        repo,
        "-c",
        "commit.gpgsign=false",
        "merge",
        "-q",
        "--no-ff",
        "-X",
        "theirs",
        "-m",
        `m-${name}`,
        name,
      );
    }

    const crlfIdx = new WorktreeIndex();
    expect(await crlfIdx.forProject(wtCrlfClean)).toEqual({
      of: crlfRepo,
      branch: "feat-crlf",
      state: "merged",
    });
    expect(await crlfIdx.forProject(wtCrlfModified)).toEqual({
      of: crlfRepo,
      branch: "feat-crlf-mod",
    });
    expect(await crlfIdx.forProject(wtCrlfRacy)).toEqual({
      of: crlfRepo,
      branch: "feat-crlf-racy",
    });

    expect(await new WorktreeIndex().forProject(wtFilter)).toEqual({
      of: filterRepo,
      branch: "feat-filter",
    });
    expect(existsSync(filterMarker)).toBe(false);

    expect(await new WorktreeIndex().forProject(wtCoreEol)).toEqual({
      of: eolRepo,
      branch: "feat-core-eol",
      state: "merged",
    });

    const attrIdx = new WorktreeIndex();
    expect(await attrIdx.forProject(wtText)).toEqual({
      of: repo,
      branch: "wt-attr-text",
      state: "merged",
    });
    expect(await attrIdx.forProject(wtEol)).toEqual({
      of: repo,
      branch: "wt-attr-eol",
      state: "merged",
    });
    expect(await attrIdx.forProject(wtEnc)).toEqual({ of: repo, branch: "wt-attr-enc" });
  });

  test("staging a file during awaited git checks invalidates index identity and returns unknown", async () => {
    const wt = join(root, "wt-stage-race");
    git(repo, "worktree", "add", "-q", "-b", "wt-stage-race", wt);
    commit(wt, "feat");
    settleWorktree(wt);
    git(repo, "merge", "-q", "--ff-only", "wt-stage-race");

    let stagedDuringCheck = false;
    const index = new WorktreeIndex((gitDir, args, opts) => {
      if (!stagedDuringCheck && args.includes("diff-index")) {
        stagedDuringCheck = true;
        // Simulate concurrent staging while the git check is in flight (after it returned clean).
        const res = spawnSync("git", [`--git-dir=${gitDir}`, ...args], {
          encoding: "utf8",
          env: GIT_ENV,
          ...(opts?.stdin !== undefined ? { input: opts.stdin } : {}),
        });
        writeFileSync(join(wt, "draft.txt"), "staged-during-check\n");
        git(wt, "add", "draft.txt");
        return res.status === 0 ? res.stdout : undefined;
      }
      const res = spawnSync("git", [`--git-dir=${gitDir}`, ...args], {
        encoding: "utf8",
        env: GIT_ENV,
        ...(opts?.stdin !== undefined ? { input: opts.stdin } : {}),
      });
      return res.status === 0 ? res.stdout : undefined;
    });

    expect(await index.forProject(wt)).toEqual({ of: repo, branch: "wt-stage-race" });
    expect(stagedDuringCheck).toBe(true);
  });

  test("hard deadline also covers filesystem work without spawning git", async () => {
    const wt = join(root, "wt-deadline-fs");
    git(repo, "worktree", "add", "-q", "-b", "wt-deadline-fs", wt);
    commit(wt, "feat");
    settleWorktree(wt);
    git(repo, "merge", "-q", "--ff-only", "wt-deadline-fs");

    let gitCalls = 0;
    const expired = new WorktreeIndex(
      () => {
        gitCalls += 1;
        return undefined;
      },
      { budgetMs: 0, now: () => 100 },
    );
    expect(await expired.forProject(wt)).toEqual({ of: repo, branch: "wt-deadline-fs" });
    expect(gitCalls).toBe(0);
  });

  test("coarse timestamps (0-nsec index/stat) reject same-size mtime-restored edits, reject 2s racy buckets, and prove untouched files via content", async () => {
    const wtCoarseEdited = join(root, "wt-coarse-edited");
    const wtCoarseClean = join(root, "wt-coarse-clean");
    const wtCoarseRacy2s = join(root, "wt-coarse-racy-2s");

    for (const [name, dir] of [
      ["wt-coarse-edited", wtCoarseEdited],
      ["wt-coarse-clean", wtCoarseClean],
      ["wt-coarse-racy-2s", wtCoarseRacy2s],
    ] as const) {
      git(repo, "worktree", "add", "-q", "-b", name, dir);
      commit(dir, `${name}.txt`, "hello world\n");
      settleWorktree(dir);
      git(repo, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", `m-${name}`, name);
    }

    // 1. Coarse-timestamp index (mtime ns = 0, ctime sec/ns = 0) + same-size edit + utimes restore -> unknown.
    const editedNote = join(wtCoarseEdited, "wt-coarse-edited.txt");
    const evenPastSec = Math.floor((Date.now() - 10_000) / 2000) * 2;
    const evenPastDate = new Date(evenPastSec * 1000);
    utimesSync(editedNote, evenPastDate, evenPastDate);
    git(wtCoarseEdited, "update-index", "--refresh");
    const editedIndexPath = join(git(wtCoarseEdited, "rev-parse", "--git-dir"), "index");
    patchIndexEntryStat(editedIndexPath, "wt-coarse-edited.txt", {
      mtimeSec: evenPastSec,
      mtimeNsec: 0,
      ctimeSec: 0,
      ctimeNsec: 0,
    });
    writeFileSync(editedNote, "hello WORLD\n");
    utimesSync(editedNote, evenPastDate, evenPastDate);

    // 2. Same coarse-timestamp index with content unchanged -> merged via content proof.
    const cleanNote = join(wtCoarseClean, "wt-coarse-clean.txt");
    utimesSync(cleanNote, evenPastDate, evenPastDate);
    git(wtCoarseClean, "update-index", "--refresh");
    const cleanIndexPath = join(git(wtCoarseClean, "rev-parse", "--git-dir"), "index");
    patchIndexEntryStat(cleanIndexPath, "wt-coarse-clean.txt", {
      mtimeSec: evenPastSec,
      mtimeNsec: 0,
      ctimeSec: 0,
      ctimeNsec: 0,
    });

    // 3. 2-second FAT/exFAT bucket racy case: entry mtime is oddIndexSec - 1 with mtimeNsec = 0.
    const racyNote = join(wtCoarseRacy2s, "wt-coarse-racy-2s.txt");
    const racyIndexPath = join(git(wtCoarseRacy2s, "rev-parse", "--git-dir"), "index");
    const idxStat = lstatSync(racyIndexPath, { bigint: true });
    const idxSec = Number((idxStat.mtimeNs / 1_000_000_000n) & 0xffffffffn);
    const bucketSec = idxSec - 1;
    const bucketDate = new Date(bucketSec * 1000);
    utimesSync(racyNote, bucketDate, bucketDate);
    git(wtCoarseRacy2s, "update-index", "--refresh");
    patchIndexEntryStat(racyIndexPath, "wt-coarse-racy-2s.txt", {
      mtimeSec: bucketSec,
      mtimeNsec: 0,
      ctimeSec: 0,
      ctimeNsec: 0,
    });
    utimesSync(racyIndexPath, new Date(idxSec * 1000 + 6), new Date(idxSec * 1000 + 6));

    const index = new WorktreeIndex();
    expect(await index.forProject(wtCoarseEdited)).toEqual({
      of: repo,
      branch: "wt-coarse-edited",
    });
    expect(await index.forProject(wtCoarseClean)).toEqual({
      of: repo,
      branch: "wt-coarse-clean",
      state: "merged",
    });
    expect(await index.forProject(wtCoarseRacy2s)).toEqual({
      of: repo,
      branch: "wt-coarse-racy-2s",
    });

    // 4. Also simulate a 2s coarse filesystem via injected `statEntry` where BOTH
    //    mtime and ctime stay truncated to the exact same even second after an edit.
    const truncate2s = (ns: bigint): bigint => (ns / 2_000_000_000n) * 2_000_000_000n;
    const makeCoarseStat = (p: string): BigIntStats => {
      const real = lstatSync(p, { bigint: true });
      if (p !== editedNote && p !== cleanNote) return real;
      const truncated = truncate2s(real.mtimeNs);
      return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        mtimeNs: truncated,
        ctimeNs: truncated,
      }) as BigIntStats;
    };
    patchIndexEntryStat(editedIndexPath, "wt-coarse-edited.txt", {
      mtimeSec: evenPastSec,
      mtimeNsec: 0,
      ctimeSec: evenPastSec,
      ctimeNsec: 0,
    });
    patchIndexEntryStat(cleanIndexPath, "wt-coarse-clean.txt", {
      mtimeSec: evenPastSec,
      mtimeNsec: 0,
      ctimeSec: evenPastSec,
      ctimeNsec: 0,
    });
    const coarseStatIndex = new WorktreeIndex(undefined, { statEntry: makeCoarseStat });
    expect(await coarseStatIndex.forProject(wtCoarseEdited)).toEqual({
      of: repo,
      branch: "wt-coarse-edited",
    });
    expect(await coarseStatIndex.forProject(wtCoarseClean)).toEqual({
      of: repo,
      branch: "wt-coarse-clean",
      state: "merged",
    });
  });

  test("ext4/POSIX touch -r same-size edit with restored mtime is rejected", async () => {
    const wt = join(root, "wt-touch-r");
    git(repo, "worktree", "add", "-q", "-b", "wt-touch-r", wt);
    commit(wt, "note.txt", "hello world\n");
    settleWorktree(wt);
    git(repo, "merge", "-q", "--ff-only", "wt-touch-r");

    const filePath = join(wt, "note.txt");
    const before = lstatSync(filePath);
    writeFileSync(filePath, "hello WORLD\n");
    utimesSync(filePath, before.atime, before.mtime);

    expect(await new WorktreeIndex().forProject(wt)).toEqual({ of: repo, branch: "wt-touch-r" });
  });

  test("Windows stat-always-weak path rejects mtime-restored edits and proves untouched CRLF and binary files via content", async () => {
    const winRepo = join(root, "app-win-sim");
    mkdirSync(winRepo);
    git(winRepo, "init", "-q", "-b", "main");
    git(winRepo, "config", "core.autocrlf", "true");
    commit(winRepo, "init.txt", "init\r\n");

    // 1. Untouched CRLF checkout + raw binary bytes (non-UTF-8 + NUL) -> merged via content proof.
    const wtWinClean = join(root, "wt-win-clean");
    git(winRepo, "worktree", "add", "-q", "-b", "wt-win-clean", wtWinClean);
    writeFileSync(join(wtWinClean, "text.txt"), "line1\r\nline2\r\n");
    const binaryPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x00]);
    writeFileSync(join(wtWinClean, "blob.bin"), binaryPayload);
    git(wtWinClean, "add", "text.txt", "blob.bin");
    git(wtWinClean, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "clean");
    settleWorktree(wtWinClean);
    git(winRepo, "merge", "-q", "--ff-only", "wt-win-clean");

    // 2. Same-size edit with restored mtime (simulating Windows `touch -r`) -> unknown.
    const wtWinEdited = join(root, "wt-win-edited");
    git(winRepo, "worktree", "add", "-q", "-b", "wt-win-edited", wtWinEdited);
    commit(wtWinEdited, "note.txt", "hello world\r\n");
    settleWorktree(wtWinEdited);
    git(winRepo, "merge", "-q", "--ff-only", "wt-win-edited");
    const editedPath = join(wtWinEdited, "note.txt");
    const before = lstatSync(editedPath);
    writeFileSync(editedPath, "hello WORLD\r\n");
    utimesSync(editedPath, before.atime, before.mtime);

    // 3. Binary file with NUL bytes edited (same size, mtime restored) -> unknown.
    const wtWinBinEdited = join(root, "wt-win-bin-edited");
    git(winRepo, "worktree", "add", "-q", "-b", "wt-win-bin-edited", wtWinBinEdited);
    writeFileSync(join(wtWinBinEdited, "data.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    git(wtWinBinEdited, "add", "data.bin");
    git(wtWinBinEdited, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "bin");
    settleWorktree(wtWinBinEdited);
    git(winRepo, "merge", "-q", "--ff-only", "wt-win-bin-edited");
    const binPath = join(wtWinBinEdited, "data.bin");
    const beforeBin = lstatSync(binPath);
    writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02, 0x04]));
    utimesSync(binPath, beforeBin.atime, beforeBin.mtime);

    // 4. `-text` / `binary` attribute with core.autocrlf=true: exact match -> merged, CRLF edit -> unknown.
    const wtWinNoEol = join(root, "wt-win-no-eol");
    git(winRepo, "worktree", "add", "-q", "-b", "wt-win-no-eol", wtWinNoEol);
    commit(wtWinNoEol, ".gitattributes", "*.raw -text\n");
    commit(wtWinNoEol, "exact.raw", "ab\n");
    settleWorktree(wtWinNoEol);
    git(winRepo, "merge", "-q", "--ff-only", "wt-win-no-eol");

    const winIndex = new WorktreeIndex(undefined, { platform: "win32" });
    expect(await winIndex.forProject(wtWinClean)).toEqual({
      of: winRepo,
      branch: "wt-win-clean",
      state: "merged",
    });
    expect(await winIndex.forProject(wtWinEdited)).toEqual({
      of: winRepo,
      branch: "wt-win-edited",
    });
    expect(await winIndex.forProject(wtWinBinEdited)).toEqual({
      of: winRepo,
      branch: "wt-win-bin-edited",
    });
    expect(await winIndex.forProject(wtWinNoEol)).toEqual({
      of: winRepo,
      branch: "wt-win-no-eol",
      state: "merged",
    });

    // Mutate `exact.raw` (same size, mtime restored) -> unknown under `-text`.
    const rawPath = join(wtWinNoEol, "exact.raw");
    const beforeRaw = lstatSync(rawPath);
    writeFileSync(rawPath, "a\r\n");
    utimesSync(rawPath, beforeRaw.atime, beforeRaw.mtime);
    expect(
      await new WorktreeIndex(undefined, { platform: "win32" }).forProject(wtWinNoEol),
    ).toEqual({ of: winRepo, branch: "wt-win-no-eol" });
  });

  test("weak-stat content proof enforces byte, per-file, file-count, and post-read stat stability bounds", async () => {
    const wt = join(root, "wt-bounds");
    git(repo, "worktree", "add", "-q", "-b", "wt-bounds", wt);
    writeFileSync(join(wt, "a.txt"), "a".repeat(256));
    writeFileSync(join(wt, "b.txt"), "b".repeat(256));
    git(wt, "add", "a.txt", "b.txt");
    git(wt, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "bounds");
    settleWorktree(wt);
    git(repo, "merge", "-q", "--ff-only", "wt-bounds");

    // Fits comfortably inside generous bounds on Windows content path -> merged.
    expect(
      await new WorktreeIndex(undefined, {
        platform: "win32",
        maxContentTotalBytes: 2048,
        maxContentFileBytes: 1024,
        maxContentFiles: 10,
      }).forProject(wt),
    ).toEqual({ of: repo, branch: "wt-bounds", state: "merged" });

    // Exceeds total content bytes cap -> unknown.
    expect(
      await new WorktreeIndex(undefined, {
        platform: "win32",
        maxContentTotalBytes: 400,
      }).forProject(wt),
    ).toEqual({ of: repo, branch: "wt-bounds" });

    // Exceeds per-file content bytes cap -> unknown.
    expect(
      await new WorktreeIndex(undefined, {
        platform: "win32",
        maxContentFileBytes: 128,
      }).forProject(wt),
    ).toEqual({ of: repo, branch: "wt-bounds" });

    // Exceeds weak file count cap -> unknown.
    expect(
      await new WorktreeIndex(undefined, {
        platform: "win32",
        maxContentFiles: 2,
      }).forProject(wt),
    ).toEqual({ of: repo, branch: "wt-bounds" });

    // Post-read stat change (simulating concurrent write during content read) -> unknown.
    let aStatCalls = 0;
    const targetA = join(wt, "a.txt");
    const racingStatIndex = new WorktreeIndex(undefined, {
      platform: "win32",
      statEntry: (p) => {
        const real = lstatSync(p, { bigint: true });
        if (p === targetA) {
          aStatCalls += 1;
          if (aStatCalls === 2) {
            return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
              mtimeNs: real.mtimeNs + 1_000_000n,
            }) as BigIntStats;
          }
        }
        return real;
      },
    });
    expect(await racingStatIndex.forProject(wt)).toEqual({ of: repo, branch: "wt-bounds" });
    expect(aStatCalls).toBeGreaterThanOrEqual(2);
  });

  test.skipIf(process.platform === "win32")(
    "POSIX strong-stat path does not invoke cat-file while weak/Windows path proves content",
    async () => {
      const wt = join(root, "wt-strong-fastpath");
      git(repo, "worktree", "add", "-q", "-b", "wt-strong-fastpath", wt);
      commit(wt, "fast.txt", "strong-stat\n");
      settleWorktree(wt);
      git(repo, "merge", "-q", "--ff-only", "wt-strong-fastpath");

      const invokedCommands: string[] = [];
      const spyRunner = (
        gitDir: string,
        args: readonly string[],
        opts?: { stdin?: string | Buffer },
      ) => {
        const cmd = args.find((a) => !a.startsWith("-") && a !== wt);
        if (cmd) invokedCommands.push(cmd);
        const res = spawnSync("git", [`--git-dir=${gitDir}`, ...args], {
          encoding: "utf8",
          env: GIT_ENV,
          ...(opts?.stdin !== undefined ? { input: opts.stdin } : {}),
        });
        return res.status === 0 ? res.stdout : undefined;
      };

      expect(await new WorktreeIndex(spyRunner).forProject(wt)).toEqual({
        of: repo,
        branch: "wt-strong-fastpath",
        state: "merged",
      });
      expect(invokedCommands).not.toContain("cat-file");

      const winCommands: string[] = [];
      const winSpy = (
        gitDir: string,
        args: readonly string[],
        opts?: { stdin?: string | Buffer },
      ) => {
        const cmd = args.find((a) => !a.startsWith("-") && a !== wt);
        if (cmd) winCommands.push(cmd);
        const res = spawnSync("git", [`--git-dir=${gitDir}`, ...args], {
          encoding: "utf8",
          env: GIT_ENV,
          ...(opts?.stdin !== undefined ? { input: opts.stdin } : {}),
        });
        return res.status === 0 ? res.stdout : undefined;
      };

      expect(await new WorktreeIndex(winSpy, { platform: "win32" }).forProject(wt)).toEqual({
        of: repo,
        branch: "wt-strong-fastpath",
        state: "merged",
      });
      expect(winCommands).toContain("cat-file");
    },
  );
});
