import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { WorktreeState } from "@kitsunekode/sweep-protocol";
import {
  canonicalPath,
  parseGitdirPointer,
  parseGitIndex,
  readSmallFile,
  readSmallText,
  type GitIndexEntry,
} from "./git-index.js";
import { gitEnv, gitSafeArgs } from "./git-tracked.js";

/**
 * Linked worktrees are where build output piles up fastest: every agent task
 * and every review branch gets its own checkout and its own install, and none
 * of them is retired when the branch lands. Grouping them under the
 * repository they belong to, and saying which ones are finished, turns
 * forty rows of `node_modules` into one decision.
 *
 * Finished is a triage hint, never a safety boundary. What it points at is
 * build output, which sweep may already remove in any project. Unknown is
 * never finished: a failed, dirty, unverified, or slow check leaves the
 * state absent (D5: Finished only on proof; anything unprovable is unknown).
 *
 * Trust & cleanliness design:
 * - Never runs `git status`, never runs repository-configured programs
 *   (fsmonitor, hooks, external diff, textconv, content filters), never
 *   touches the network (protocol.allow=never plus per-protocol never
 *   overrides), and never writes to the repository.
 * - Delegates Git semantics to hardened read-only Git plumbing where Git
 *   answers without running repo-configured programs:
 *   - Remotes & base: `git remote`, `git config --list --null`,
 *     `git symbolic-ref refs/remotes/origin/HEAD`, `git for-each-ref`.
 *   - Content conversion guard: `git check-attr --stdin -z filter
 *     working-tree-encoding` (plus `text` and `eol` when weak-stat entries need
 *     content proof); runs no filters; any enabled `filter` or
 *     `working-tree-encoding` attribute makes the worktree unknown.
 *   - Staged changes: `git diff-index --cached --quiet --no-ext-diff
 *     --no-textconv --ignore-submodules=none <tipOid> --`.
 *   - Untracked non-ignored files: `git ls-files --others --exclude-standard -z`
 *     with `-c core.untrackedCache=false -c core.fsmonitor=false` and bounded
 *     output size and time.
 *   - Weak-stat content proof: when an entry's stat match is weak (e.g. zero
 *     cached mtime/ctime nanoseconds on coarse-clock filesystems, missing
 *     ctime/uid/gid match on POSIX, or any entry on Windows), raw index blobs
 *     are fetched via `git cat-file --batch` (no filters, bounded output/bytes)
 *     and compared against bounded no-follow working file reads (with CRLF->LF
 *     normalization only when effective EOL conversion applies to that path).
 * - Unstaged changes use read-only `.git/index` parsing (with trailing
 *   checksum verification, bounded path/entry limits, rejection of split/sparse
 *   indexes, unknown extensions, gitlinks/submodules, and suppressing flags)
 *   plus `lstat` classification; any stat mismatch or racily-clean entry
 *   (same-second mtime vs index mtime, or within 2 seconds when cached mtime
 *   nanoseconds are 0) makes the worktree unknown.
 * - Index identity (dev, ino, size, mtime, ctime, trailing checksum) plus
 *   in-progress markers, HEAD branch, branch tip OID, and base ref OID are
 *   verified before and after all checks; any change makes the state unknown.
 * - Merge proof requires branch-specific reflog evidence; missing reflogs or
 *   disabled reflogs leave the state unknown.
 */

export interface WorktreeInfo {
  /** Canonical path to the main work tree (or bare repository) this checkout belongs to. */
  of: string;
  /** The checked-out branch; absent on a detached HEAD. */
  branch?: string;
  state?: WorktreeState;
}

export interface WorktreeIndexOptions {
  /** Total monotonic budget for git enrichment across all repos in one scan. */
  budgetMs?: number;
  /** Monotonic clock source (in ms) for deterministic testing. */
  now?: () => number;
  /** Cancellation signal from the owning scan. */
  signal?: AbortSignal;
  /** Override the `git` executable path (primarily for tests). */
  gitBinary?: string;
  /** Override platform stat/proof rules (primarily for cross-platform tests). */
  platform?: NodeJS.Platform;
  /** Override `lstat` for tracked entries (primarily for coarse-timestamp tests). */
  statEntry?: (path: string) => BigIntStats;
  /** Cap total weak-entry content bytes compared per worktree (default 64 MiB). */
  maxContentTotalBytes?: number;
  /** Cap single weak-entry content bytes compared (default 8 MiB). */
  maxContentFileBytes?: number;
  /** Cap number of weak entries content-checked per worktree (default 10,000). */
  maxContentFiles?: number;
}

interface RepoBranches {
  /** Local branch name of the verified base, so a worktree on the base itself is not "finished". */
  base: string | undefined;
  /** Full ref name of the verified base (e.g. `refs/remotes/origin/main` or `refs/heads/main`). */
  baseRef: string | undefined;
  /** Commit OID of the verified base ref. */
  baseOid: string | undefined;
  /** Local branches that are ancestors of `baseOid`, mapped to their tip OID. */
  merged: ReadonlyMap<string, string>;
  gone: ReadonlySet<string>;
}

export interface GitRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string | Buffer;
  maxStdoutBytes?: number;
}

export type GitRunner = (
  gitDir: string,
  args: readonly string[],
  options?: GitRunOptions,
) => Promise<string | undefined> | string | undefined;

type GitRawRunner = (
  gitDir: string,
  args: readonly string[],
  options?: GitRunOptions,
) => Promise<Buffer | undefined> | Buffer | undefined;

const TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 150;
const MAX_GIT_STDOUT = 16 * 1024 * 1024;
const MAX_UNTRACKED_STDOUT = 64 * 1024;
export const DEFAULT_WORKTREE_BUDGET_MS = 2_000;
export const DEFAULT_MAX_CONTENT_TOTAL_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_CONTENT_FILE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_CONTENT_FILES = 10_000;
const CAT_FILE_BATCH_MAX_ENTRIES = 4_000;
const CAT_FILE_BATCH_MAX_BYTES = 16 * 1024 * 1024;
const CAT_FILE_HEADER_OVERHEAD_BYTES = 128;
const POINTER_MAX_BYTES = 4096;
const REFLOG_MAX_BYTES = 256 * 1024;
const PACKED_REFS_MAX_BYTES = 8 * 1024 * 1024;
const CLEAN_INDEX_MAX_BYTES = 32 * 1024 * 1024;
const CLEAN_INDEX_MAX_ENTRIES = 100_000;
const CLEAN_INDEX_MAX_PATH_BYTES = 16 * 1024 * 1024;
const CHECK_ATTR_CHUNK_PATHS = 4_000;

const HEADS = "refs/heads/";
const ORIGIN_REMOTES = "refs/remotes/origin/";
const ZERO_OID = /^0+$/;
const HEX_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const OWN_COMMIT_REFLOG = /^(?:commit(?::|\s*\()|cherry-pick:|revert:)/;
const REBASE_REFLOG = /^rebase(?:\s|:)/;
const RESET_OR_CREATE_REFLOG = /^(?:reset:|branch:\s*Reset\b|branch:\s*Created\b)/i;

const IN_PROGRESS_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
  "HEAD.lock",
  "index.lock",
] as const;

const UNSAFE_CONVERSION_ATTRS = ["filter", "working-tree-encoding"] as const;
const WEAK_CONVERSION_ATTRS = ["filter", "working-tree-encoding", "text", "eol"] as const;

function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals, forceGroup = false): void {
  if (!forceGroup && (proc.exitCode !== null || proc.signalCode !== null)) return;
  if (process.platform !== "win32" && proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fall through to direct child kill.
    }
  }
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    proc.kill(signal);
  } catch {
    // Child already exited.
  }
}

function terminateChildBounded(proc: ChildProcess, onForceSettled?: () => void): void {
  killProcessTree(proc, "SIGTERM", true);
  const force = setTimeout(() => {
    killProcessTree(proc, "SIGKILL", true);
    onForceSettled?.();
  }, KILL_GRACE_MS);
  force.unref();
  proc.once("close", () => clearTimeout(force));
}

function createGitRawRunner(gitBinary = "git"): GitRawRunner {
  return (gitDir, args, options) => {
    if (options?.signal?.aborted) return Promise.resolve(undefined);
    const timeout = Math.max(1, Math.min(TIMEOUT_MS, options?.timeoutMs ?? TIMEOUT_MS));
    const maxStdout = options?.maxStdoutBytes ?? MAX_GIT_STDOUT;

    let safeArgs: string[];
    try {
      safeArgs = gitSafeArgs();
    } catch {
      return Promise.resolve(undefined);
    }
    const gitArgs = [...safeArgs, `--git-dir=${gitDir}`, ...args];

    return new Promise<Buffer | undefined>((resolvePromise) => {
      let settled = false;
      let timedOutOrAborted = false;
      let stdoutBytes = 0;
      const chunks: Buffer[] = [];

      let proc: ChildProcess;
      try {
        proc = spawn(gitBinary, gitArgs, {
          env: gitEnv(),
          stdio: [options?.stdin !== undefined ? "pipe" : "ignore", "pipe", "ignore"],
          detached: process.platform !== "win32",
        });
      } catch {
        resolvePromise(undefined);
        return;
      }

      const cleanup = () => {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onCancel);
      };

      const finish = (value: Buffer | undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(value);
      };

      const onCancel = () => {
        if (timedOutOrAborted) return;
        timedOutOrAborted = true;
        proc.stdin?.destroy();
        proc.stdout?.destroy();
        terminateChildBounded(proc, () => finish(undefined));
      };

      const timer = setTimeout(onCancel, timeout);
      timer.unref();
      options?.signal?.addEventListener("abort", onCancel, { once: true });
      if (options?.signal?.aborted) onCancel();

      if (options?.stdin !== undefined && proc.stdin) {
        proc.stdin.on("error", () => {
          // Ignore EPIPE when git exits before consuming stdin.
        });
        proc.stdin.end(options.stdin);
      }

      proc.stdout?.on("data", (chunk: Buffer) => {
        if (settled || timedOutOrAborted) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdout) {
          onCancel();
          return;
        }
        chunks.push(chunk);
      });

      proc.stdout?.on("error", () => {
        onCancel();
      });

      proc.on("error", () => {
        finish(undefined);
      });

      proc.on("close", (code, signal) => {
        if (timedOutOrAborted || code !== 0 || signal !== null) {
          finish(undefined);
          return;
        }
        finish(Buffer.concat(chunks));
      });
    });
  };
}

export function createGitRunner(gitBinary = "git"): GitRunner {
  const raw = createGitRawRunner(gitBinary);
  return async (gitDir, args, options) => {
    const out = await raw(gitDir, args, options);
    return out === undefined ? undefined : out.toString("utf8");
  };
}

/** `<common>/worktrees/<name>` for a linked worktree; undefined for a main tree or submodule. */
function linkedGitDir(
  root: string,
): { realRoot: string; gitDir: string; common: string; of: string } | undefined {
  const realRoot = canonicalPath(root);
  if (!realRoot) return undefined;
  const pointer = readSmallText(resolve(realRoot, ".git"), POINTER_MAX_BYTES);
  if (pointer === undefined) return undefined;
  const target = parseGitdirPointer(pointer);
  if (!target) return undefined;
  const rawGitDir = isAbsolute(target) ? target : resolve(realRoot, target);
  const gitDir = canonicalPath(rawGitDir);
  if (!gitDir) return undefined;
  // Only a linked worktree has `commondir`; a submodule's git dir does not.
  const commondirRaw = readSmallText(resolve(gitDir, "commondir"), POINTER_MAX_BYTES);
  if (commondirRaw === undefined) return undefined;
  const commondir = (commondirRaw.split(/\r?\n/, 1)[0] ?? "").trim();
  if (!commondir) return undefined;
  const rawCommon = isAbsolute(commondir) ? commondir : resolve(gitDir, commondir);
  const common = canonicalPath(rawCommon);
  if (!common) return undefined;
  const rawOf = basename(common) === ".git" ? dirname(common) : common;
  const of = canonicalPath(rawOf);
  if (!of) return undefined;
  return { realRoot, gitDir, common, of };
}

function readCheckedOutBranch(gitDir: string): string | undefined {
  const head = readSmallText(resolve(gitDir, "HEAD"), POINTER_MAX_BYTES)?.trim() ?? "";
  return head.startsWith(`ref: ${HEADS}`) ? head.slice(5 + HEADS.length) : undefined;
}

function splitSafeRefSegments(refSuffix: string): string[] | undefined {
  if (!refSuffix || refSuffix.includes("\\") || refSuffix.includes("\0")) return undefined;
  const parts = refSuffix.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") return undefined;
    for (let i = 0; i < part.length; i++) {
      const code = part.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return undefined;
    }
  }
  return parts;
}

/** Verify `childReal` is strictly inside `baseReal` using canonical paths. */
function isStrictlyInsideCanonical(baseReal: string, childReal: string): boolean {
  const normBase = process.platform === "win32" ? baseReal.toLowerCase() : baseReal;
  const normChild = process.platform === "win32" ? childReal.toLowerCase() : childReal;
  const rel = relative(normBase, normChild);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Safely open and read a file nested under `baseDirParts` (within `common`)
 * along `relSegments`, rejecting symlinked directories or files and verifying
 * the opened file's real path remains strictly under the canonical base dir.
 */
function readContainedGitMetaFile(
  common: string,
  baseDirParts: readonly string[],
  relSegments: readonly string[],
  maxBytes: number,
): { status: "ok"; text: string } | { status: "missing" } | { status: "rejected" } {
  // Walk base directories (e.g. logs -> refs -> heads), rejecting symlinks.
  let current = common;
  for (const part of baseDirParts) {
    current = join(current, part);
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) return { status: "rejected" };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "rejected" };
    }
  }
  const realBase = canonicalPath(current);
  if (!realBase) return { status: "rejected" };

  // Walk intermediate branch-namespace directories, rejecting symlinks.
  for (let i = 0; i < relSegments.length - 1; i++) {
    current = join(current, relSegments[i]!);
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) return { status: "rejected" };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "rejected" };
    }
  }

  const leafPath = join(current, relSegments[relSegments.length - 1]!);
  try {
    const lmeta = lstatSync(leafPath);
    if (lmeta.isSymbolicLink() || !lmeta.isFile() || lmeta.size > maxBytes) {
      return { status: "rejected" };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "rejected" };
  }

  let fd: number | undefined;
  try {
    const flags =
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    fd = openSync(leafPath, flags);
    const fdMeta = fstatSync(fd, { bigint: true });
    if (!fdMeta.isFile() || fdMeta.size > BigInt(maxBytes)) return { status: "rejected" };

    // Confirm the opened file's real path stays strictly under `realBase`.
    if (process.platform === "linux") {
      try {
        const fdRealPath = readlinkSync(`/proc/self/fd/${fd}`);
        if (fdRealPath.endsWith(" (deleted)") || !isStrictlyInsideCanonical(realBase, fdRealPath)) {
          return { status: "rejected" };
        }
      } catch {
        // Fallback to realpath + identity verification below when /proc is unavailable.
      }
    }

    const realLeaf = canonicalPath(leafPath);
    if (!realLeaf || !isStrictlyInsideCanonical(realBase, realLeaf)) {
      return { status: "rejected" };
    }
    const realMeta = lstatSync(realLeaf, { bigint: true });
    if (
      fdMeta.ino !== 0n &&
      (realMeta.dev !== fdMeta.dev || realMeta.ino !== fdMeta.ino || !realMeta.isFile())
    ) {
      return { status: "rejected" };
    }

    const expected = Number(fdMeta.size);
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, expected + 1));
    let total = 0;
    while (total <= maxBytes) {
      const remaining = buffer.length - total;
      if (remaining === 0) {
        const probe = Buffer.allocUnsafe(1);
        const n = readSync(fd, probe, 0, 1, null);
        if (n === 0) break;
        return { status: "rejected" };
      }
      const n = readSync(fd, buffer, total, remaining, null);
      if (n === 0) break;
      total += n;
    }
    if (total > maxBytes) return { status: "rejected" };
    return { status: "ok", text: buffer.subarray(0, total).toString("utf8") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "rejected" };
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

/**
 * Read the current commit OID of any full `refs/...` ref directly from loose
 * refs or `packed-refs` (no git spawn, never stale).
 */
function readFullRefOid(common: string, fullRef: string): string | undefined {
  if (!fullRef.startsWith("refs/")) return undefined;
  const segments = splitSafeRefSegments(fullRef.slice(5));
  if (!segments) return undefined;

  const loose = readContainedGitMetaFile(common, ["refs"], segments, POINTER_MAX_BYTES);
  if (loose.status === "ok") {
    const val = loose.text.trim();
    return HEX_OID.test(val) ? val : undefined;
  }
  if (loose.status === "rejected") return undefined;

  const packed = readSmallText(resolve(common, "packed-refs"), PACKED_REFS_MAX_BYTES);
  if (!packed) return undefined;
  for (const line of packed.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space < 40) continue;
    const oid = line.slice(0, space);
    const ref = line.slice(space + 1).trim();
    if (ref === fullRef) {
      return HEX_OID.test(oid) ? oid : undefined;
    }
  }
  return undefined;
}

function readBranchTipOid(common: string, branch: string): string | undefined {
  return readFullRefOid(common, `${HEADS}${branch}`);
}

type ReflogEvidence =
  | { kind: "proven"; ownCommitOid: string }
  | { kind: "disproven" }
  | { kind: "missing" };

/**
 * Inspect `<common>/logs/refs/heads/<branch>` for affirmative branch-specific
 * evidence of a commit authored on this branch reaching `tipOid`.
 *
 * Without a valid reflog proving an authored commit on this branch, merge
 * proof is absent and the worktree stays unknown.
 */
function checkBranchReflog(common: string, branch: string, tipOid: string): ReflogEvidence {
  const segments = splitSafeRefSegments(branch);
  if (!segments) return { kind: "disproven" };

  const reflog = readContainedGitMetaFile(
    common,
    ["logs", "refs", "heads"],
    segments,
    REFLOG_MAX_BYTES,
  );
  if (reflog.status === "missing") return { kind: "missing" };
  if (reflog.status === "rejected") return { kind: "disproven" };

  const lines = reflog.text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return { kind: "disproven" };

  let baselineOid: string | undefined;
  let ownCommitOid: string | undefined;
  let lastNewOid = "";

  for (const line of lines) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const header = line.slice(0, tab);
    const message = line.slice(tab + 1).trim();
    const fields = header.split(" ");
    const oldOid = fields[0] ?? "";
    const newOid = fields[1] ?? "";
    if (!oldOid || !newOid) continue;

    if (baselineOid === undefined) {
      baselineOid = ZERO_OID.test(oldOid) ? newOid : oldOid;
    }

    if (RESET_OR_CREATE_REFLOG.test(message)) {
      // A branch creation or reset invalidates any earlier own-commit claim.
      ownCommitOid = undefined;
      baselineOid = newOid;
    } else if (OWN_COMMIT_REFLOG.test(message)) {
      ownCommitOid = newOid;
    } else if (REBASE_REFLOG.test(message)) {
      // Rebase preserves own-commit status only if the branch already had one.
      if (ownCommitOid !== undefined) {
        ownCommitOid = newOid;
      }
    }

    lastNewOid = newOid;
  }

  if (!baselineOid || !ownCommitOid) return { kind: "disproven" };
  if (tipOid === baselineOid || lastNewOid !== tipOid) return { kind: "disproven" };
  return { kind: "proven", ownCommitOid };
}

function hasInProgressOperation(gitDir: string): boolean {
  for (const marker of IN_PROGRESS_MARKERS) {
    try {
      lstatSync(join(gitDir, marker));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

interface IndexIdentity {
  exists: boolean;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  checksumHex: string;
}

function sameIndexIdentity(a: IndexIdentity, b: IndexIdentity): boolean {
  return (
    a.exists === b.exists &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.checksumHex === b.checksumHex
  );
}

type TrackedEntryStatus =
  | { kind: "mismatch" }
  | { kind: "strong"; stat: BigIntStats }
  | { kind: "weak"; stat: BigIntStats; segments: string[]; absPath: string };

interface WeakTrackedEntry {
  entry: GitIndexEntry;
  segments: string[];
  absPath: string;
  beforeStat: BigIntStats;
}

interface PathEolAttrs {
  text: string;
  eol: string;
}

type EolMode = "none" | "text" | "auto";

function defaultStatEntry(path: string): BigIntStats {
  return lstatSync(path, { bigint: true });
}

function sameFileIdentityStat(a: BigIntStats, b: BigIntStats, platform: NodeJS.Platform): boolean {
  if (a.size !== b.size || a.mtimeNs !== b.mtimeNs || a.ctimeNs !== b.ctimeNs) {
    return false;
  }
  if (a.mode !== b.mode) return false;
  if (platform !== "win32") {
    return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid;
  }
  if (a.dev !== 0n && b.dev !== 0n && a.dev !== b.dev) return false;
  if (a.ino !== 0n && b.ino !== 0n && a.ino !== b.ino) return false;
  return true;
}

/**
 * Read-only index stat classification for a single tracked entry.
 * - Returns `"mismatch"` on any hard mismatch, gitlink/submodule, suppressing
 *   flag, or racily-clean entry (same-second mtime vs index mtime, or within
 *   2 seconds when cached mtime nanoseconds are 0).
 * - Returns `"strong"` ONLY on POSIX when cached mtime ns is non-zero and
 *   matches, cached ctime sec+ns are non-zero and match, uid/gid match,
 *   ino/dev match (when cached non-zero), size/mode/mtime sec match, and the
 *   entry is not racy.
 * - Returns `"weak"` on Windows (always) or whenever stat metadata alone cannot
 *   prove the working bytes equal the index blob (e.g. 0-nsec coarse clocks,
 *   missing ctime, or uid/gid difference). Weak entries require content proof.
 */
function classifyTrackedEntry(
  realRoot: string,
  entry: GitIndexEntry,
  indexStat: BigIntStats,
  platform: NodeJS.Platform,
  statEntry: (path: string) => BigIntStats,
): TrackedEntryStatus {
  // Reject non-zero merge stage, assume-unchanged, and any extended flags
  // (skip-worktree, intent-to-add, etc.).
  const stage = (entry.flags >> 12) & 0x3;
  if (stage !== 0 || (entry.flags & 0x8000) !== 0 || entry.extFlags !== 0) {
    return { kind: "mismatch" };
  }

  const segments = splitSafeRefSegments(entry.path);
  if (!segments) return { kind: "mismatch" };

  const fileType = entry.mode & 0o170000;
  // Reject gitlinks / submodules (0o160000) and any non-file/non-symlink type.
  if (fileType !== 0o100000 && fileType !== 0o120000) {
    return { kind: "mismatch" };
  }

  const absPath = join(realRoot, ...segments);
  let stat: BigIntStats;
  try {
    stat = statEntry(absPath);
  } catch {
    return { kind: "mismatch" };
  }

  if (fileType === 0o120000) {
    if (!stat.isSymbolicLink()) return { kind: "mismatch" };
  } else {
    // Regular file (`0o100644` or `0o100755`).
    if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "mismatch" };
    if (platform !== "win32") {
      const indexExec = (entry.mode & 0o100) !== 0;
      const diskExec = (Number(stat.mode) & 0o100) !== 0;
      if (indexExec !== diskExec) return { kind: "mismatch" };
    }
  }

  if (stat.size > 0xffffffffn || stat.size !== BigInt(entry.size)) {
    return { kind: "mismatch" };
  }
  if (stat.mtimeNs < 0n || stat.ctimeNs < 0n || indexStat.mtimeNs < 0n) {
    return { kind: "mismatch" };
  }

  const mtimeSec = Number((stat.mtimeNs / 1_000_000_000n) & 0xffffffffn);
  const mtimeNsec = Number(stat.mtimeNs % 1_000_000_000n);
  const ctimeSec = Number((stat.ctimeNs / 1_000_000_000n) & 0xffffffffn);
  const ctimeNsec = Number(stat.ctimeNs % 1_000_000_000n);

  if (entry.mtimeSec === 0 || mtimeSec !== entry.mtimeSec) {
    return { kind: "mismatch" };
  }

  // Racily-clean check: any entry whose mtime is in the same second as or
  // newer than the index mtime is racy. When cached mtime nanoseconds are 0
  // (coarse 1s/2s filesystem clocks like FAT/exFAT/HFS+), require the entry
  // to be strictly older than a 2-second bucket before the index mtime.
  const indexMtimeSec = Number((indexStat.mtimeNs / 1_000_000_000n) & 0xffffffffn);
  if (entry.mtimeSec >= indexMtimeSec) {
    return { kind: "mismatch" };
  }
  if (entry.mtimeNsec === 0 && entry.mtimeSec + 2 >= indexMtimeSec) {
    return { kind: "mismatch" };
  }

  // On Windows, stat is never strong proof: ctime is creation time, POSIX
  // inode/device/uid/gid metadata is not reliable, and `touch -r`-style mtime
  // restores pass stat comparisons. Always verify content on Windows.
  if (platform === "win32") {
    return { kind: "weak", stat, segments, absPath };
  }

  // On POSIX, reject explicit mismatches on cached non-zero stat fields.
  if (entry.mtimeNsec !== 0 && mtimeNsec !== entry.mtimeNsec) return { kind: "mismatch" };
  if (entry.ino !== 0 && Number(stat.ino & 0xffffffffn) !== entry.ino) return { kind: "mismatch" };
  if (entry.dev !== 0 && Number(stat.dev & 0xffffffffn) !== entry.dev) return { kind: "mismatch" };
  if (entry.ctimeSec !== 0 && ctimeSec !== entry.ctimeSec) return { kind: "mismatch" };
  if (entry.ctimeNsec !== 0 && ctimeNsec !== entry.ctimeNsec) return { kind: "mismatch" };

  const hasStrongMtime = entry.mtimeNsec !== 0 && mtimeNsec === entry.mtimeNsec;
  const hasStrongCtime =
    entry.ctimeSec !== 0 &&
    entry.ctimeNsec !== 0 &&
    ctimeSec === entry.ctimeSec &&
    ctimeNsec === entry.ctimeNsec;
  const uidMatches = Number(stat.uid & 0xffffffffn) === entry.uid;
  const gidMatches = Number(stat.gid & 0xffffffffn) === entry.gid;

  if (hasStrongMtime && hasStrongCtime && uidMatches && gidMatches) {
    return { kind: "strong", stat };
  }

  return { kind: "weak", stat, segments, absPath };
}

function verifyParentDirsNotSymlinks(
  realRoot: string,
  segments: readonly string[],
  verifiedDirs: Set<string>,
): boolean {
  let current = realRoot;
  for (let i = 0; i < segments.length - 1; i++) {
    current = join(current, segments[i]!);
    if (verifiedDirs.has(current)) continue;
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
      verifiedDirs.add(current);
    } catch {
      return false;
    }
  }
  return true;
}

function readRegularWorkingFile(
  absPath: string,
  expectedSize: number,
  maxBytes: number,
  beforeStat: BigIntStats,
  platform: NodeJS.Platform,
  statEntry: (path: string) => BigIntStats,
  hasCustomStatEntry: boolean,
): Buffer | undefined {
  if (expectedSize < 0 || expectedSize > maxBytes) return undefined;
  let fd: number | undefined;
  try {
    const flags =
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    fd = openSync(absPath, flags);
    const fdStat = fstatSync(fd, { bigint: true });
    if (
      !fdStat.isFile() ||
      fdStat.size !== BigInt(expectedSize) ||
      fdStat.size > BigInt(maxBytes)
    ) {
      return undefined;
    }
    if (!hasCustomStatEntry && !sameFileIdentityStat(beforeStat, fdStat, platform)) {
      return undefined;
    }

    const buffer = Buffer.allocUnsafe(expectedSize);
    let total = 0;
    while (total < expectedSize) {
      const n = readSync(fd, buffer, total, expectedSize - total, null);
      if (n === 0) return undefined;
      total += n;
    }
    const probe = Buffer.allocUnsafe(1);
    if (readSync(fd, probe, 0, 1, null) !== 0) return undefined;

    const afterFdStat = fstatSync(fd, { bigint: true });
    if (!sameFileIdentityStat(fdStat, afterFdStat, platform)) return undefined;

    closeSync(fd);
    fd = undefined;

    const afterLstat = statEntry(absPath);
    if (!afterLstat.isFile() || afterLstat.isSymbolicLink()) return undefined;
    if (!sameFileIdentityStat(beforeStat, afterLstat, platform)) return undefined;

    return buffer;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors on read-only descriptors.
      }
    }
  }
}

function readSymlinkWorkingTarget(
  absPath: string,
  expectedSize: number,
  maxBytes: number,
  beforeStat: BigIntStats,
  platform: NodeJS.Platform,
  statEntry: (path: string) => BigIntStats,
): Buffer | undefined {
  if (expectedSize < 0 || expectedSize > maxBytes) return undefined;
  try {
    const target = readlinkSync(absPath, { encoding: "buffer" });
    if (target.length !== expectedSize || target.length > maxBytes) return undefined;
    const afterLstat = statEntry(absPath);
    if (!afterLstat.isSymbolicLink()) return undefined;
    if (!sameFileIdentityStat(beforeStat, afterLstat, platform)) return undefined;
    return target;
  } catch {
    return undefined;
  }
}

/** Zero-allocation comparison: true iff `work` with every CRLF normalized to LF equals `blob`. */
function equalsAfterCrlfToLf(work: Buffer, blob: Buffer): boolean {
  if (work.length <= blob.length) return false;
  let wi = 0;
  let bi = 0;
  const wLen = work.length;
  const bLen = blob.length;
  while (wi < wLen) {
    const wb = work[wi]!;
    if (wb === 0x0d && wi + 1 < wLen && work[wi + 1] === 0x0a) {
      wi += 1;
      continue;
    }
    if (bi >= bLen || blob[bi] !== wb) return false;
    wi += 1;
    bi += 1;
  }
  return bi === bLen;
}

function effectiveEolMode(attrs: PathEolAttrs, config: ReadonlyMap<string, string>): EolMode {
  if (attrs.text === "unset") return "none";
  if (attrs.text === "auto") return "auto";
  if (attrs.text === "set") return "text";
  if (attrs.eol === "crlf" || attrs.eol === "lf") return "text";
  if (attrs.text !== "unspecified") return "none";
  if (attrs.eol !== "unspecified" && attrs.eol !== "unset") return "none";

  const autocrlf = (config.get("core.autocrlf") ?? "false").trim().toLowerCase();
  if (
    autocrlf === "true" ||
    autocrlf === "yes" ||
    autocrlf === "on" ||
    autocrlf === "1" ||
    autocrlf === "input"
  ) {
    return "auto";
  }
  return "none";
}

function parseCatFileBatchOutput(
  buf: Buffer,
  expectedOids: readonly string[],
  maxFileBytes: number,
  maxBatchTotalBytes: number,
): Map<string, Buffer> | undefined {
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  let totalBlobBytes = 0;

  for (let i = 0; i < expectedOids.length; i++) {
    const expectedOid = expectedOids[i]!;
    const nl = buf.indexOf(0x0a, offset);
    if (nl < 0) return undefined;
    const header = buf.subarray(offset, nl).toString("ascii");
    offset = nl + 1;

    const firstSpace = header.indexOf(" ");
    if (firstSpace < 0) return undefined;
    const secondSpace = header.indexOf(" ", firstSpace + 1);
    if (secondSpace < 0 || header.indexOf(" ", secondSpace + 1) >= 0) return undefined;

    const oid = header.slice(0, firstSpace);
    const type = header.slice(firstSpace + 1, secondSpace);
    const sizeStr = header.slice(secondSpace + 1);

    if (oid !== expectedOid || type !== "blob" || !/^\d+$/.test(sizeStr)) {
      return undefined;
    }

    const size = Number(sizeStr);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes) {
      return undefined;
    }
    totalBlobBytes += size;
    if (totalBlobBytes > maxBatchTotalBytes) {
      return undefined;
    }

    if (offset + size + 1 > buf.length) return undefined;
    if (buf[offset + size] !== 0x0a) return undefined;

    blobs.set(oid, buf.subarray(offset, offset + size));
    offset += size + 1;
  }

  if (offset !== buf.length) return undefined;
  return blobs;
}

/** Parse `git config --list --null` into a last-value-wins map (keys already lowercased by Git). */
function parseGitConfigNull(stdout: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (stdout.length === 0) return entries;
  const records = stdout.split("\0");
  // Trailing empty string after final NUL is expected.
  for (const record of records) {
    if (!record) continue;
    const nl = record.indexOf("\n");
    if (nl < 0) {
      // Valueless boolean key in git config (e.g. `[core]\n\tautocrlf`) means `"true"`.
      entries.set(record, "true");
    } else {
      entries.set(record.slice(0, nl), record.slice(nl + 1));
    }
  }
  return entries;
}

function parseCheckAttrOutput(
  stdout: string,
  slice: readonly GitIndexEntry[],
  attrs: readonly string[],
  collectEol: Map<string, PathEolAttrs> | undefined,
): boolean {
  const fields = stdout.split("\0");
  // `check-attr -z` terminates every triplet with NUL, leaving one trailing empty element.
  if (fields.length === 0 || fields[fields.length - 1] !== "") return false;
  const count = fields.length - 1;
  const expectedFields = slice.length * attrs.length * 3;
  if (count !== expectedFields) return false;

  let idx = 0;
  for (let p = 0; p < slice.length; p++) {
    const path = slice[p]!.path;
    let text = "unspecified";
    let eol = "unspecified";
    for (let a = 0; a < attrs.length; a++) {
      const outPath = fields[idx]!;
      const attrName = fields[idx + 1]!;
      const value = fields[idx + 2]!;
      idx += 3;
      if (outPath !== path || attrName !== attrs[a]) return false;
      if (attrName === "filter" || attrName === "working-tree-encoding") {
        if (value !== "unspecified" && value !== "unset") {
          return false;
        }
      } else if (attrName === "text") {
        text = value;
      } else if (attrName === "eol") {
        eol = value;
      }
    }
    if (collectEol) {
      collectEol.set(path, { text, eol });
    }
  }
  return true;
}

export class WorktreeIndex {
  private readonly projects = new Map<string, Promise<WorktreeInfo | undefined>>();
  private readonly repos = new Map<string, Promise<RepoBranches | undefined>>();
  private readonly git: GitRunner;
  private readonly rawGit: GitRawRunner;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly statEntry: (path: string) => BigIntStats;
  private readonly hasCustomStatEntry: boolean;
  private readonly maxContentTotalBytes: number;
  private readonly maxContentFileBytes: number;
  private readonly maxContentFiles: number;

  constructor(git?: GitRunner, options: WorktreeIndexOptions = {}) {
    if (git) {
      this.git = git;
      this.rawGit = async (gitDir, args, runOptions) => {
        const out = await git(gitDir, args, runOptions);
        return out === undefined ? undefined : Buffer.from(out, "utf8");
      };
    } else {
      const raw = createGitRawRunner(options.gitBinary);
      this.rawGit = raw;
      this.git = async (gitDir, args, runOptions) => {
        const out = await raw(gitDir, args, runOptions);
        return out === undefined ? undefined : out.toString("utf8");
      };
    }
    this.now = options.now ?? (() => performance.now());
    const budgetMs = Math.max(0, options.budgetMs ?? DEFAULT_WORKTREE_BUDGET_MS);
    this.deadlineMs = this.now() + budgetMs;
    this.signal = options.signal;
    this.platform = options.platform ?? process.platform;
    this.hasCustomStatEntry = options.statEntry !== undefined;
    this.statEntry = options.statEntry ?? defaultStatEntry;
    this.maxContentTotalBytes = Math.max(
      0,
      options.maxContentTotalBytes ?? DEFAULT_MAX_CONTENT_TOTAL_BYTES,
    );
    this.maxContentFileBytes = Math.max(
      0,
      options.maxContentFileBytes ?? DEFAULT_MAX_CONTENT_FILE_BYTES,
    );
    this.maxContentFiles = Math.max(0, options.maxContentFiles ?? DEFAULT_MAX_CONTENT_FILES);
  }

  /** Worktree facts for a project root; undefined when it is not a linked worktree. */
  forProject(root: string): Promise<WorktreeInfo | undefined> {
    const key = canonicalPath(root) ?? root;
    const cached = this.projects.get(key);
    if (cached !== undefined) return cached;
    const pending = this.read(key);
    this.projects.set(key, pending);
    return pending;
  }

  private remainingBudgetMs(): number {
    if (this.signal?.aborted) return 0;
    return Math.max(0, this.deadlineMs - this.now());
  }

  private isExpired(): boolean {
    return this.remainingBudgetMs() <= 0;
  }

  private async runBoundedGit(
    gitDir: string,
    args: readonly string[],
    extra?: Pick<GitRunOptions, "stdin" | "maxStdoutBytes">,
  ): Promise<string | undefined> {
    const remaining = this.remainingBudgetMs();
    if (remaining <= 0) return undefined;
    const timeoutMs = Math.min(TIMEOUT_MS, remaining);
    const out = await this.git(gitDir, args, {
      timeoutMs,
      ...(this.signal ? { signal: this.signal } : {}),
      ...extra,
    });
    if (this.isExpired()) return undefined;
    return out;
  }

  private async runBoundedGitRaw(
    gitDir: string,
    args: readonly string[],
    extra?: Pick<GitRunOptions, "stdin" | "maxStdoutBytes">,
  ): Promise<Buffer | undefined> {
    const remaining = this.remainingBudgetMs();
    if (remaining <= 0) return undefined;
    const timeoutMs = Math.min(TIMEOUT_MS, remaining);
    const out = await this.rawGit(gitDir, args, {
      timeoutMs,
      ...(this.signal ? { signal: this.signal } : {}),
      ...extra,
    });
    if (this.isExpired()) return undefined;
    return out;
  }

  private async read(root: string): Promise<WorktreeInfo | undefined> {
    const linked = linkedGitDir(root);
    if (!linked) return undefined;
    const { realRoot, gitDir, common, of } = linked;
    const branch = readCheckedOutBranch(gitDir);
    if (!branch) return { of };

    if (this.isExpired()) return { of, branch };

    const repo = await this.branches(common);
    if (!repo || branch === repo.base || this.isExpired()) return { of, branch };

    // Evaluate `upstream_gone` before merge classification (D5): a branch whose
    // tracking ref is missing never reads as finished.
    if (repo.gone.has(branch)) {
      return { of, branch, state: "upstream_gone" };
    }

    const tipOid = repo.merged.get(branch);
    if (tipOid === undefined || !repo.baseRef || !repo.baseOid) return { of, branch };

    // Pin branch tip before proof and cleanliness checks so a cached ref scan
    // cannot pair with a newer unmerged commit.
    if (this.isExpired() || readBranchTipOid(common, branch) !== tipOid) {
      return { of, branch };
    }

    if (!(await this.isProvenMerged(common, branch, tipOid, repo))) {
      return { of, branch };
    }

    if (!(await this.isWorktreeClean(gitDir, realRoot, tipOid))) {
      return { of, branch };
    }

    // Re-verify budget, HEAD branch, branch tip OID, and base ref OID after
    // cleanliness checks to close concurrent commit/switch/base-move races.
    if (
      this.isExpired() ||
      readCheckedOutBranch(gitDir) !== branch ||
      readBranchTipOid(common, branch) !== tipOid ||
      readFullRefOid(common, repo.baseRef) !== repo.baseOid
    ) {
      return { of, branch };
    }

    return { of, branch, state: "merged" };
  }

  private async isProvenMerged(
    common: string,
    branch: string,
    tipOid: string,
    repo: RepoBranches,
  ): Promise<boolean> {
    if (this.isExpired() || !repo.baseRef || !repo.baseOid) return false;
    const reflog = checkBranchReflog(common, branch, tipOid);
    if (reflog.kind !== "proven") return false;
    if (reflog.ownCommitOid === tipOid) return true;
    // Branch moved after its own commit: verify the authored commit is still
    // reachable from `tipOid`.
    const out = await this.runBoundedGit(common, [
      "merge-base",
      "--is-ancestor",
      reflog.ownCommitOid,
      tipOid,
    ]);
    return out !== undefined;
  }

  /**
   * Conservative cleanliness check:
   * 1. Rejects in-progress git operations (`MERGE_HEAD`, locks, rebase, etc.).
   * 2. Records index identity (dev, ino, size, mtime, ctime, trailing checksum)
   *    before all checks and classifies every tracked entry by `lstat`
   *    (rejecting split/sparse/unknown-extension indexes, gitlinks, suppressing
   *    flags, stat mismatches, and racily-clean entries).
   * 3. Checks effective unsafe conversion attributes (`git check-attr --stdin -z
   *    filter working-tree-encoding`, plus `text`/`eol` when weak entries exist),
   *    failing closed if any `filter` or `working-tree-encoding` attribute is
   *    enabled.
   * 4. Checks staged changes via `git diff-index --cached --quiet <tipOid>`.
   * 5. Checks untracked non-ignored files via bounded
   *    `git ls-files --others --exclude-standard -z`.
   * 6. For any weak-stat entries (and all entries on Windows), proves content
   *    equality against raw index blobs via `git cat-file --batch` (no filters,
   *    bounded bytes/files) and bounded no-follow working reads (with CRLF->LF
   *    normalization only when effective EOL conversion applies to that path).
   * 7. Re-verifies deadline, in-progress markers, index file identity, and
   *    tracked entry stats (including weak-entry stability) after all awaits.
   */
  private async isWorktreeClean(
    gitDir: string,
    realRoot: string,
    tipOid: string,
  ): Promise<boolean> {
    if (this.isExpired()) return false;
    if (hasInProgressOperation(gitDir)) return false;

    const hashLen: 20 | 32 | undefined =
      tipOid.length === 40 ? 20 : tipOid.length === 64 ? 32 : undefined;
    if (!hashLen) return false;

    const indexPath = join(gitDir, "index");
    let indexEntries: GitIndexEntry[];
    let indexStat: BigIntStats | undefined;
    let beforeIdentity: IndexIdentity;
    let beforeBytes: Buffer | undefined;

    try {
      lstatSync(indexPath);
      const indexFile = readSmallFile(indexPath, CLEAN_INDEX_MAX_BYTES);
      if (!indexFile || this.isExpired()) return false;
      indexStat = indexFile.stat;
      beforeBytes = indexFile.bytes;
      const parsed = parseGitIndex(indexFile.bytes, hashLen, {
        allowSplitIndex: false,
        maxEntries: CLEAN_INDEX_MAX_ENTRIES,
        maxTotalPathBytes: CLEAN_INDEX_MAX_PATH_BYTES,
        isExpired: () => this.isExpired(),
      });
      if (!parsed.ok) return false;
      indexEntries = parsed.entries;
      beforeIdentity = {
        exists: true,
        dev: indexFile.stat.dev,
        ino: indexFile.stat.ino,
        size: indexFile.stat.size,
        mtimeNs: indexFile.stat.mtimeNs,
        ctimeNs: indexFile.stat.ctimeNs,
        checksumHex: parsed.checksumHex,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        indexEntries = [];
        beforeIdentity = {
          exists: false,
          dev: 0n,
          ino: 0n,
          size: 0n,
          mtimeNs: 0n,
          ctimeNs: 0n,
          checksumHex: "",
        };
      } else {
        return false;
      }
    }

    // Fast read-only unstaged stat classification before spawning subprocesses.
    const weakEntries: WeakTrackedEntry[] = [];
    const weakByPath = new Map<string, WeakTrackedEntry>();
    for (let i = 0; i < indexEntries.length; i++) {
      if ((i & 0x3f) === 0 && this.isExpired()) return false;
      if (!indexStat) return false;
      const entry = indexEntries[i]!;
      const status = classifyTrackedEntry(
        realRoot,
        entry,
        indexStat,
        this.platform,
        this.statEntry,
      );
      if (status.kind === "mismatch") return false;
      if (status.kind === "weak") {
        const weak: WeakTrackedEntry = {
          entry,
          segments: status.segments,
          absPath: status.absPath,
          beforeStat: status.stat,
        };
        weakEntries.push(weak);
        weakByPath.set(entry.path, weak);
      }
    }

    // Check unsafe conversion attributes (`filter`, `working-tree-encoding`) for
    // all tracked paths without running filters. When weak entries need content
    // proof, also query `text` and `eol` in the same pass.
    const needsContentProof = weakEntries.length > 0;
    const checkAttrs = needsContentProof ? WEAK_CONVERSION_ATTRS : UNSAFE_CONVERSION_ATTRS;
    const eolAttrsByPath = needsContentProof ? new Map<string, PathEolAttrs>() : undefined;
    if (indexEntries.length > 0) {
      for (let start = 0; start < indexEntries.length; start += CHECK_ATTR_CHUNK_PATHS) {
        if (this.isExpired()) return false;
        const slice = indexEntries.slice(start, start + CHECK_ATTR_CHUNK_PATHS);
        const stdin = `${slice.map((entry) => entry.path).join("\0")}\0`;
        const attrOut = await this.runBoundedGit(
          gitDir,
          [`--work-tree=${realRoot}`, "-C", realRoot, "check-attr", "--stdin", "-z", ...checkAttrs],
          { stdin },
        );
        if (
          attrOut === undefined ||
          !parseCheckAttrOutput(attrOut, slice, checkAttrs, eolAttrsByPath)
        ) {
          return false;
        }
      }
    }

    // Check staged changes (index vs tipOid tree, no worktree reads, no filters).
    const diffCached = await this.runBoundedGit(gitDir, [
      "diff-index",
      "--cached",
      "--quiet",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      tipOid,
      "--",
    ]);
    if (diffCached === undefined) return false;

    // Check untracked non-ignored files with Git itself (`core.untrackedCache=false`
    // and `core.fsmonitor=false` are already set by `gitSafeArgs()`).
    const untracked = await this.runBoundedGit(
      gitDir,
      [
        `--work-tree=${realRoot}`,
        "-C",
        realRoot,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      { maxStdoutBytes: MAX_UNTRACKED_STDOUT },
    );
    if (untracked === undefined || untracked.length > 0) return false;

    // Content proof for every weak-stat entry (and all entries on Windows),
    // running no filters and strictly enforcing byte/file/deadline bounds.
    if (needsContentProof) {
      const proven = await this.verifyWeakEntriesContent(
        gitDir,
        realRoot,
        weakEntries,
        eolAttrsByPath!,
      );
      if (!proven) return false;
    }

    // Post-check stability: reject if deadline expired, in-progress markers
    // appeared, the index file identity/checksum changed, or any tracked file
    // changed on disk during the awaited git calls.
    if (this.isExpired() || hasInProgressOperation(gitDir)) return false;

    let afterIdentity: IndexIdentity;
    let afterBytes: Buffer | undefined;
    try {
      lstatSync(indexPath);
      const afterFile = readSmallFile(indexPath, CLEAN_INDEX_MAX_BYTES);
      if (!afterFile || afterFile.bytes.length < hashLen) return false;
      afterBytes = afterFile.bytes;
      const trailerHex = afterFile.bytes.subarray(afterFile.bytes.length - hashLen).toString("hex");
      afterIdentity = {
        exists: true,
        dev: afterFile.stat.dev,
        ino: afterFile.stat.ino,
        size: afterFile.stat.size,
        mtimeNs: afterFile.stat.mtimeNs,
        ctimeNs: afterFile.stat.ctimeNs,
        checksumHex: trailerHex,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        afterIdentity = {
          exists: false,
          dev: 0n,
          ino: 0n,
          size: 0n,
          mtimeNs: 0n,
          ctimeNs: 0n,
          checksumHex: "",
        };
      } else {
        return false;
      }
    }

    if (!sameIndexIdentity(beforeIdentity, afterIdentity)) return false;
    if (beforeBytes && (!afterBytes || !beforeBytes.equals(afterBytes))) return false;

    for (let i = 0; i < indexEntries.length; i++) {
      if ((i & 0x3f) === 0 && this.isExpired()) return false;
      if (!indexStat) return false;
      const entry = indexEntries[i]!;
      const status = classifyTrackedEntry(
        realRoot,
        entry,
        indexStat,
        this.platform,
        this.statEntry,
      );
      if (status.kind === "mismatch") return false;
      const weak = weakByPath.get(entry.path);
      if (weak && !sameFileIdentityStat(weak.beforeStat, status.stat, this.platform)) {
        return false;
      }
    }

    return true;
  }

  private async verifyWeakEntriesContent(
    gitDir: string,
    realRoot: string,
    weakEntries: readonly WeakTrackedEntry[],
    eolAttrsByPath: ReadonlyMap<string, PathEolAttrs>,
  ): Promise<boolean> {
    if (this.isExpired()) return false;
    if (weakEntries.length > this.maxContentFiles) return false;

    // Pre-check per-file and total byte caps before spawning git or reading files.
    let plannedBytes = 0;
    for (let i = 0; i < weakEntries.length; i++) {
      const size = weakEntries[i]!.entry.size;
      if (size > this.maxContentFileBytes) return false;
      plannedBytes += size;
      if (plannedBytes > this.maxContentTotalBytes) return false;
    }

    // Read effective worktree config (`core.autocrlf`, `core.eol`) once.
    const worktreeConfigOut = await this.runBoundedGit(gitDir, [
      `--work-tree=${realRoot}`,
      "-C",
      realRoot,
      "config",
      "--list",
      "--null",
    ]);
    if (worktreeConfigOut === undefined) return false;
    const worktreeConfig = parseGitConfigNull(worktreeConfigOut);

    const verifiedDirs = new Set<string>();
    let comparedBlobBytes = 0;
    let comparedWorkBytes = 0;
    let cursor = 0;

    while (cursor < weakEntries.length) {
      if (this.isExpired()) return false;

      const batch: WeakTrackedEntry[] = [];
      const batchOids: string[] = [];
      const seenOids = new Set<string>();
      let batchEstimatedBytes = 0;

      while (cursor < weakEntries.length && batch.length < CAT_FILE_BATCH_MAX_ENTRIES) {
        const item = weakEntries[cursor]!;
        if (batch.length > 0 && batchEstimatedBytes + item.entry.size > CAT_FILE_BATCH_MAX_BYTES) {
          break;
        }
        batch.push(item);
        batchEstimatedBytes += item.entry.size;
        if (!seenOids.has(item.entry.oidHex)) {
          seenOids.add(item.entry.oidHex);
          batchOids.push(item.entry.oidHex);
        }
        cursor += 1;
      }

      const remainingBlobBytes = this.maxContentTotalBytes - comparedBlobBytes;
      if (remainingBlobBytes < 0) return false;
      const maxStdoutBytes = remainingBlobBytes + batchOids.length * CAT_FILE_HEADER_OVERHEAD_BYTES;
      const rawBatch = await this.runBoundedGitRaw(gitDir, ["cat-file", "--batch"], {
        stdin: `${batchOids.join("\n")}\n`,
        maxStdoutBytes,
      });
      if (rawBatch === undefined) return false;

      const blobs = parseCatFileBatchOutput(
        rawBatch,
        batchOids,
        this.maxContentFileBytes,
        remainingBlobBytes,
      );
      if (!blobs) return false;
      for (const blob of blobs.values()) {
        comparedBlobBytes += blob.length;
      }
      if (comparedBlobBytes > this.maxContentTotalBytes) return false;

      for (let i = 0; i < batch.length; i++) {
        if ((i & 0x1f) === 0 && this.isExpired()) return false;
        const { entry, segments, absPath, beforeStat } = batch[i]!;
        const blob = blobs.get(entry.oidHex);
        if (!blob) return false;

        if (!verifyParentDirsNotSymlinks(realRoot, segments, verifiedDirs)) {
          return false;
        }

        const remainingWorkBytes = this.maxContentTotalBytes - comparedWorkBytes;
        const entryMaxBytes = Math.min(this.maxContentFileBytes, remainingWorkBytes);
        const fileType = entry.mode & 0o170000;
        const workBytes =
          fileType === 0o120000
            ? readSymlinkWorkingTarget(
                absPath,
                entry.size,
                entryMaxBytes,
                beforeStat,
                this.platform,
                this.statEntry,
              )
            : readRegularWorkingFile(
                absPath,
                entry.size,
                entryMaxBytes,
                beforeStat,
                this.platform,
                this.statEntry,
                this.hasCustomStatEntry,
              );
        if (!workBytes) return false;

        comparedWorkBytes += workBytes.length;
        if (comparedWorkBytes > this.maxContentTotalBytes) return false;

        if (workBytes.equals(blob)) continue;

        if (fileType !== 0o100000) return false;
        const attrs = eolAttrsByPath.get(entry.path);
        if (!attrs) return false;
        const eolMode = effectiveEolMode(attrs, worktreeConfig);
        if (eolMode === "none") return false;
        if (eolMode === "auto" && (workBytes.includes(0) || blob.includes(0))) {
          return false;
        }
        if (!equalsAfterCrlfToLf(workBytes, blob)) return false;
      }
    }

    return true;
  }

  private branches(common: string): Promise<RepoBranches | undefined> {
    const cached = this.repos.get(common);
    if (cached !== undefined) return cached;
    const pending = this.readBranches(common);
    this.repos.set(common, pending);
    return pending;
  }

  private async readBranches(common: string): Promise<RepoBranches | undefined> {
    const listing = await this.runBoundedGit(common, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(upstream:track)%00%(symref)",
      "refs/heads",
      "refs/remotes/origin",
    ]);
    if (listing === undefined) return undefined;

    const localOids = new Map<string, string>();
    const remoteOids = new Map<string, string>();
    const gone = new Set<string>();
    let hasOriginRefs = false;

    for (const line of listing.split("\n")) {
      if (!line) continue;
      const [ref = "", oid = "", track = ""] = line.split("\0");
      if (ref === "refs/remotes/origin/HEAD" || ref.startsWith(ORIGIN_REMOTES)) {
        hasOriginRefs = true;
        if (oid && HEX_OID.test(oid)) remoteOids.set(ref, oid);
      } else if (ref.startsWith(HEADS)) {
        const name = ref.slice(HEADS.length);
        if (oid && HEX_OID.test(oid)) localOids.set(name, oid);
        if (track === "[gone]") gone.add(name);
      }
    }

    // Resolve remotes and config with Git itself so `[include]`, `[includeIf]`,
    // and case-insensitive section names (e.g. `[REMOTE "origin"]`) work
    // identically to Git. Any failure to read config or remotes fails closed.
    const remotesOut = await this.runBoundedGit(common, ["remote"]);
    if (remotesOut === undefined) return undefined;
    const remotes = new Set(
      remotesOut
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );

    const repoConfigOut = await this.runBoundedGit(common, ["config", "--list", "--null"]);
    if (repoConfigOut === undefined) return undefined;
    const repoConfig = parseGitConfigNull(repoConfigOut);
    let hasOriginConfig = false;
    for (const key of repoConfig.keys()) {
      if (key.startsWith("remote.origin.")) {
        hasOriginConfig = true;
        break;
      }
    }

    const hasOrigin = remotes.has("origin") || hasOriginConfig || hasOriginRefs;

    // Verified base selection:
    // 1. When `origin` exists: resolve `refs/remotes/origin/HEAD` via Git. If
    //    it cannot be resolved locally to a valid commit OID, base is unknown.
    // 2. Otherwise (confirmed local-only repo): use the branch checked out in
    //    the main worktree (`<common>/HEAD`), never a guessed `main`/`master`.
    let baseRef: string | undefined;
    let baseOid: string | undefined;
    let base: string | undefined;

    if (hasOrigin) {
      const symrefOut = await this.runBoundedGit(common, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
      ]);
      const targetRef = symrefOut?.trim();
      if (targetRef) {
        const targetOid =
          remoteOids.get(targetRef) ??
          (targetRef.startsWith(HEADS) ? localOids.get(targetRef.slice(HEADS.length)) : undefined);
        if (targetOid && HEX_OID.test(targetOid)) {
          baseRef = targetRef;
          baseOid = targetOid;
          base = targetRef.startsWith(ORIGIN_REMOTES)
            ? targetRef.slice(ORIGIN_REMOTES.length)
            : targetRef.startsWith(HEADS)
              ? targetRef.slice(HEADS.length)
              : undefined;
        }
      }
    } else {
      const mainBranch = readCheckedOutBranch(common);
      const mainOid = mainBranch ? localOids.get(mainBranch) : undefined;
      if (mainBranch && mainOid) {
        base = mainBranch;
        baseRef = `${HEADS}${mainBranch}`;
        baseOid = mainOid;
      }
    }

    if (!baseRef || !baseOid) {
      return { base: undefined, baseRef: undefined, baseOid: undefined, merged: new Map(), gone };
    }

    // Pin the ancestry query to the exact observed `baseOid`.
    const mergedOut = await this.runBoundedGit(common, [
      "for-each-ref",
      `--merged=${baseOid}`,
      "--format=%(refname)%00%(objectname)",
      "refs/heads",
    ]);
    if (mergedOut === undefined) {
      return { base: undefined, baseRef: undefined, baseOid: undefined, merged: new Map(), gone };
    }
    const merged = new Map<string, string>();
    for (const line of mergedOut.split("\n")) {
      if (!line) continue;
      const [ref = "", oid = ""] = line.split("\0");
      if (ref.startsWith(HEADS) && oid && HEX_OID.test(oid)) {
        merged.set(ref.slice(HEADS.length), oid);
      }
    }
    return { base, baseRef, baseOid, merged, gone };
  }
}
