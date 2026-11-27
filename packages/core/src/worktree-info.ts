import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { WorktreeState } from "@kitsunekode/sweep-protocol";
import { GIT_ARGS, GIT_ENV } from "./git-tracked.js";

/**
 * Linked worktrees are where build output piles up fastest: every agent task
 * and every review branch gets its own checkout and its own install, and none
 * of them is retired when the branch lands. Grouping them under the
 * repository they belong to, and saying which ones are finished, turns
 * forty rows of `node_modules` into one decision.
 *
 * Finished is a triage hint, never a safety boundary. What it points at is
 * build output, which sweep may already remove in any project. Unknown is
 * never finished: a failed or slow git call leaves the state absent.
 *
 * Cost: the pointer files are read directly (no spawn). Branch state takes at
 * most two `git for-each-ref` calls per repository, however many worktrees it
 * has, with the same hardening as the tracked-file check.
 */

export interface WorktreeInfo {
  /** The main work tree (or the bare repository) this checkout belongs to. */
  of: string;
  /** The checked-out branch; absent on a detached HEAD. */
  branch?: string;
  state?: WorktreeState;
}

interface RepoBranches {
  /** Local branch name of the base, so a worktree on the base itself is not "finished". */
  base: string | undefined;
  merged: ReadonlySet<string>;
  gone: ReadonlySet<string>;
}

export type GitRunner = (gitDir: string, args: readonly string[]) => string | undefined;

const TIMEOUT_MS = 5_000;
const POINTER_MAX_BYTES = 4096;

const runGit: GitRunner = (gitDir, args) => {
  const result = spawnSync("git", [...GIT_ARGS, `--git-dir=${gitDir}`, ...args], {
    env: GIT_ENV,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && typeof result.stdout === "string" ? result.stdout : undefined;
};

function readSmall(path: string): string | undefined {
  try {
    const meta = lstatSync(path);
    if (!meta.isFile() || meta.size > POINTER_MAX_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** `<common>/worktrees/<name>` for a linked worktree; undefined for a main tree or submodule. */
function linkedGitDir(root: string): { gitDir: string; common: string } | undefined {
  const pointer = readSmall(resolve(root, ".git"));
  if (pointer === undefined) return undefined;
  const line = pointer.split("\n")[0] ?? "";
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

export class WorktreeIndex {
  private readonly projects = new Map<string, WorktreeInfo | null>();
  private readonly repos = new Map<string, RepoBranches | null>();

  constructor(private readonly git: GitRunner = runGit) {}

  /** Worktree facts for a project root; undefined when it is not a linked worktree. */
  forProject(root: string): WorktreeInfo | undefined {
    const cached = this.projects.get(root);
    if (cached !== undefined) return cached ?? undefined;
    const info = this.read(root);
    this.projects.set(root, info ?? null);
    return info;
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
    const state: WorktreeState | undefined = repo.merged.has(branch)
      ? "merged"
      : repo.gone.has(branch)
        ? "upstream_gone"
        : undefined;
    return state ? { of, branch, state } : { of, branch };
  }

  private branches(common: string): RepoBranches | undefined {
    const cached = this.repos.get(common);
    if (cached !== undefined) return cached ?? undefined;
    const repo = this.readBranches(common);
    this.repos.set(common, repo ?? null);
    return repo;
  }

  private readBranches(common: string): RepoBranches | undefined {
    const listing = this.git(common, [
      "for-each-ref",
      "--format=%(refname)%00%(upstream:track)%00%(symref)",
      "refs/heads",
      "refs/remotes/origin/HEAD",
    ]);
    if (listing === undefined) return undefined;

    const local = new Set<string>();
    const gone = new Set<string>();
    let originHead: string | undefined;
    for (const line of listing.split("\n")) {
      const [ref = "", track = "", symref = ""] = line.split("\0");
      if (ref === "refs/remotes/origin/HEAD") {
        if (symref) originHead = symref;
      } else if (ref.startsWith(HEADS)) {
        const name = ref.slice(HEADS.length);
        local.add(name);
        if (track === "[gone]") gone.add(name);
      }
    }

    // The branch work lands on: the remote's default, else a local main/master.
    const baseRef =
      originHead ??
      (local.has("main") ? `${HEADS}main` : local.has("master") ? `${HEADS}master` : undefined);
    if (!baseRef) return { base: undefined, merged: new Set(), gone };
    const base = baseRef.startsWith("refs/remotes/origin/")
      ? baseRef.slice("refs/remotes/origin/".length)
      : baseRef.slice(HEADS.length);

    const mergedOut = this.git(common, [
      "for-each-ref",
      `--merged=${baseRef}`,
      "--format=%(refname)",
      "refs/heads",
    ]);
    const merged = new Set<string>();
    for (const ref of mergedOut?.split("\n") ?? []) {
      if (ref.startsWith(HEADS)) merged.add(ref.slice(HEADS.length));
    }
    return { base, merged, gone };
  }
}
