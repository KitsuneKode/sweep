import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import type { WorktreeState } from "@kitsunekode/sweep-protocol";
import { GIT_ARGS, gitEnv } from "./git-tracked.js";

/**
 * Linked worktrees are where build output piles up fastest: every agent task
 * and every review branch gets its own checkout and its own install, and none
 * of them is retired when the branch lands. Grouping them under the
 * repository they belong to, and saying which ones are finished, turns
 * forty rows of `node_modules` into one decision.
 *
 * Finished is a triage hint, never a safety boundary. What it points at is
 * build output, which sweep may already remove in any project. Unknown is
 * never finished: a failed, dirty, unverified, or slow git check leaves the
 * state absent.
 *
 * Cost: the pointer files and reflogs are read directly (no spawn). Branch
 * state takes at most two `git for-each-ref` calls per repository, however
 * many worktrees it has, and all git enrichment shares one per-scan time
 * budget.
 */

export interface WorktreeInfo {
  /** The main work tree (or the bare repository) this checkout belongs to. */
  of: string;
  /** The checked-out branch; absent on a detached HEAD. */
  branch?: string;
  state?: WorktreeState;
}

export interface WorktreeIndexOptions {
  /** Total wall-clock budget for git enrichment across all repos in one scan. */
  budgetMs?: number;
  /** Clock source for deterministic testing. */
  now?: () => number;
}

interface RepoBranches {
  /** Local branch name of the verified base, so a worktree on the base itself is not "finished". */
  base: string | undefined;
  /** Full ref name of the verified base (e.g. `refs/remotes/origin/main` or `refs/heads/main`). */
  baseRef: string | undefined;
  /** Commit OID of the verified base ref. */
  baseOid: string | undefined;
  /** Local branches that are ancestors of `baseRef`, mapped to their tip OID. */
  merged: ReadonlyMap<string, string>;
  gone: ReadonlySet<string>;
}

export interface GitRunOptions {
  timeoutMs?: number;
  cwd?: string;
}

export type GitRunner = (
  gitDir: string,
  args: readonly string[],
  options?: GitRunOptions,
) => string | undefined;

const TIMEOUT_MS = 5_000;
export const DEFAULT_WORKTREE_BUDGET_MS = 2_000;
const POINTER_MAX_BYTES = 4096;
const REFLOG_MAX_BYTES = 256 * 1024;
const FIRST_PARENT_MAX_COMMITS = 5_000;

const runGit: GitRunner = (gitDir, args, options) => {
  const timeout = Math.max(1, Math.min(TIMEOUT_MS, options?.timeoutMs ?? TIMEOUT_MS));
  const gitArgs = options?.cwd
    ? [...GIT_ARGS, "-C", options.cwd, ...args]
    : [...GIT_ARGS, `--git-dir=${gitDir}`, ...args];
  const result = spawnSync("git", gitArgs, {
    env: gitEnv(),
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && typeof result.stdout === "string" ? result.stdout : undefined;
};

function readSmall(path: string, maxBytes = POINTER_MAX_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    const lmeta = lstatSync(path);
    if (!lmeta.isFile() || lmeta.isSymbolicLink() || lmeta.size > maxBytes) return undefined;
    const flags =
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    fd = openSync(path, flags);
    const fmeta = fstatSync(fd);
    if (!fmeta.isFile() || fmeta.size > maxBytes) return undefined;
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const n = readSync(fd, buffer, total, maxBytes + 1 - total, null);
      if (n === 0) break;
      total += n;
    }
    if (total > maxBytes) return undefined;
    return buffer.subarray(0, total).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close error on read-only descriptor.
      }
    }
  }
}

/** `<common>/worktrees/<name>` for a linked worktree; undefined for a main tree or submodule. */
function linkedGitDir(root: string): { gitDir: string; common: string } | undefined {
  const pointer = readSmall(resolve(root, ".git"));
  if (pointer === undefined) return undefined;
  const line = pointer.split(/\r?\n/, 1)[0] ?? "";
  if (!line.startsWith("gitdir:")) return undefined;
  const target = line.slice(7).trim();
  if (!target) return undefined;
  const gitDir = isAbsolute(target) ? target : resolve(root, target);
  // Only a linked worktree has `commondir`; a submodule's git dir does not.
  const commondir = readSmall(resolve(gitDir, "commondir"))?.trim();
  if (!commondir) return undefined;
  return { gitDir, common: isAbsolute(commondir) ? commondir : resolve(gitDir, commondir) };
}

const HEADS = "refs/heads/";
const ZERO_OID = /^0+$/;
const OWN_COMMIT_REFLOG = /^(?:commit(?::|\s*\()|cherry-pick:|revert:|rebase(?:\s|:))/;

/**
 * Prove from the local branch reflog that `branch` authored at least one
 * commit of its own reaching `tipOid` (rather than sitting untouched at its
 * creation point or only fast-forwarding from base).
 */
function branchHasOwnCommitFromReflog(common: string, branch: string, tipOid: string): boolean {
  const logsBase = resolve(common, "logs", "refs", "heads");
  const logPath = resolve(logsBase, branch);
  if (!logPath.startsWith(`${logsBase}${sep}`)) return false;
  const text = readSmall(logPath, REFLOG_MAX_BYTES);
  if (!text) return false;

  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return false;

  let createdOid: string | undefined;
  let hasOwnCommit = false;
  let lastNewOid = "";
  let lastMessage = "";

  for (const line of lines) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const header = line.slice(0, tab);
    const message = line.slice(tab + 1).trim();
    const fields = header.split(" ");
    const oldOid = fields[0] ?? "";
    const newOid = fields[1] ?? "";
    if (!oldOid || !newOid) continue;
    if (createdOid === undefined) {
      createdOid = ZERO_OID.test(oldOid) ? newOid : oldOid;
    }
    if (OWN_COMMIT_REFLOG.test(message)) {
      hasOwnCommit = true;
    }
    lastNewOid = newOid;
    lastMessage = message;
  }

  if (!createdOid || !hasOwnCommit) return false;
  if (tipOid === createdOid || lastNewOid !== tipOid) return false;
  if (lastMessage.startsWith("reset:")) return false;
  return true;
}

export class WorktreeIndex {
  private readonly projects = new Map<string, WorktreeInfo | null>();
  private readonly repos = new Map<string, RepoBranches | null>();
  private readonly now: () => number;
  private readonly deadlineMs: number;

  constructor(
    private readonly git: GitRunner = runGit,
    options: WorktreeIndexOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    const budgetMs = Math.max(0, options.budgetMs ?? DEFAULT_WORKTREE_BUDGET_MS);
    this.deadlineMs = this.now() + budgetMs;
  }

  /** Worktree facts for a project root; undefined when it is not a linked worktree. */
  forProject(root: string): WorktreeInfo | undefined {
    const cached = this.projects.get(root);
    if (cached !== undefined) return cached ?? undefined;
    const info = this.read(root);
    this.projects.set(root, info ?? null);
    return info;
  }

  private remainingBudgetMs(): number {
    return Math.max(0, this.deadlineMs - this.now());
  }

  private runBoundedGit(gitDir: string, args: readonly string[], cwd?: string): string | undefined {
    const remaining = this.remainingBudgetMs();
    if (remaining <= 0) return undefined;
    const timeoutMs = Math.min(TIMEOUT_MS, remaining);
    return this.git(gitDir, args, cwd === undefined ? { timeoutMs } : { timeoutMs, cwd });
  }

  private read(root: string): WorktreeInfo | undefined {
    const linked = linkedGitDir(root);
    if (!linked) return undefined;
    const { gitDir, common } = linked;
    const of = basename(common) === ".git" ? dirname(common) : common;
    const head = readSmall(resolve(gitDir, "HEAD"))?.trim() ?? "";
    const branch = head.startsWith(`ref: ${HEADS}`) ? head.slice(5 + HEADS.length) : undefined;
    if (!branch) return { of };
    const repo = this.branches(common);
    if (!repo || branch === repo.base) return { of, branch };

    const tipOid = repo.merged.get(branch);
    let state: WorktreeState | undefined;
    if (
      tipOid !== undefined &&
      this.isProvenMerged(common, branch, tipOid, repo) &&
      this.isWorktreeClean(common, root)
    ) {
      state = "merged";
    } else if (repo.gone.has(branch)) {
      state = "upstream_gone";
    }
    return state ? { of, branch, state } : { of, branch };
  }

  private isProvenMerged(
    common: string,
    branch: string,
    tipOid: string,
    repo: RepoBranches,
  ): boolean {
    if (!repo.baseRef || !repo.baseOid) return false;
    // Fast path (no spawn): branch reflog proves this branch created commits reaching tipOid.
    if (branchHasOwnCommitFromReflog(common, branch, tipOid)) return true;
    // A branch sitting on the exact base tip without reflog proof cannot be
    // distinguished from a freshly created zero-commit branch.
    if (tipOid === repo.baseOid) return false;
    // DAG proof for merge commits (works even when reflogs are missing/expired):
    // if `tipOid` is NOT on `first-parent(baseRef)`, it entered `baseRef` via a
    // merge commit's non-first parent, proving it held commits of its own.
    return this.isMergedOutsideFirstParent(common, tipOid, repo.baseRef);
  }

  private isMergedOutsideFirstParent(common: string, tipOid: string, baseRef: string): boolean {
    const out = this.runBoundedGit(common, [
      "rev-list",
      "--first-parent",
      "--parents",
      `--max-count=${FIRST_PARENT_MAX_COMMITS}`,
      `${tipOid}..${baseRef}`,
    ]);
    if (out === undefined) return false;
    const lines = out.split("\n").filter((line) => line.length > 0);
    // Empty or truncated history cannot prove the branch is off first-parent.
    if (lines.length === 0 || lines.length >= FIRST_PARENT_MAX_COMMITS) return false;
    const oldest = lines[lines.length - 1] ?? "";
    const firstParent = oldest.split(" ")[1];
    return firstParent !== tipOid;
  }

  /** Clean only when `git status` succeeds within budget and reports no changes. */
  private isWorktreeClean(common: string, root: string): boolean {
    const status = this.runBoundedGit(
      common,
      ["status", "--porcelain=v1", "--untracked-files=normal", "--no-renames"],
      root,
    );
    return status === "";
  }

  private branches(common: string): RepoBranches | undefined {
    const cached = this.repos.get(common);
    if (cached !== undefined) return cached ?? undefined;
    const repo = this.readBranches(common);
    this.repos.set(common, repo ?? null);
    return repo;
  }

  private readBranches(common: string): RepoBranches | undefined {
    const listing = this.runBoundedGit(common, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(upstream:track)%00%(symref)",
      "refs/heads",
      "refs/remotes/origin/HEAD",
    ]);
    if (listing === undefined) return undefined;

    const localOids = new Map<string, string>();
    const gone = new Set<string>();
    let originHead: string | undefined;
    let originHeadOid: string | undefined;
    for (const line of listing.split("\n")) {
      if (!line) continue;
      const [ref = "", oid = "", track = "", symref = ""] = line.split("\0");
      if (ref === "refs/remotes/origin/HEAD") {
        if (symref && oid) {
          originHead = symref;
          originHeadOid = oid;
        }
      } else if (ref.startsWith(HEADS)) {
        const name = ref.slice(HEADS.length);
        if (oid) localOids.set(name, oid);
        if (track === "[gone]") gone.add(name);
      }
    }

    // Verified base branch: remote default (origin/HEAD), else local main/master.
    const baseRef =
      originHead ??
      (localOids.has("main")
        ? `${HEADS}main`
        : localOids.has("master")
          ? `${HEADS}master`
          : undefined);
    const baseOid =
      originHead !== undefined
        ? originHeadOid
        : baseRef?.startsWith(HEADS)
          ? localOids.get(baseRef.slice(HEADS.length))
          : undefined;
    if (!baseRef || !baseOid) {
      return { base: undefined, baseRef: undefined, baseOid: undefined, merged: new Map(), gone };
    }
    const base = baseRef.startsWith("refs/remotes/origin/")
      ? baseRef.slice("refs/remotes/origin/".length)
      : baseRef.slice(HEADS.length);

    const mergedOut = this.runBoundedGit(common, [
      "for-each-ref",
      `--merged=${baseRef}`,
      "--format=%(refname)%00%(objectname)",
      "refs/heads",
    ]);
    const merged = new Map<string, string>();
    for (const line of mergedOut?.split("\n") ?? []) {
      if (!line) continue;
      const [ref = "", oid = ""] = line.split("\0");
      if (ref.startsWith(HEADS) && oid) merged.set(ref.slice(HEADS.length), oid);
    }
    return { base, baseRef, baseOid, merged, gone };
  }
}
