import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { WorktreeState } from "@kitsunekode/sweep-protocol";
import {
  canonicalPath,
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
 * state absent.
 *
 * Trust & cleanliness design:
 * - Enrichment never runs `git status`, never runs repository-configured
 *   programs (fsmonitor, hooks, external diff, filters), never touches the
 *   network, and never writes to the repository.
 * - Cleanliness is determined data-only: we parse `.git/index` directly,
 *   reject unsupported layouts (split/sparse/unknown extensions/versions),
 *   reject gitlinks/submodules, reject suppressing flags (assume-unchanged,
 *   skip-worktree, intent-to-add, merge conflicts), reject in-progress git
 *   operations (`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`,
 *   `rebase-merge`, `rebase-apply`, `BISECT_LOG`, `sequencer`, locks),
 *   compare every tracked entry's stat data against `lstat` (with bounded
 *   blob-hash verification for racily-clean same-second entries), compare
 *   index entries against `git ls-tree -r -z <tipOid>` to catch staged
 *   changes, and perform a bounded untracked-file walk honoring `.gitignore`
 *   and `<common>/info/exclude` (any non-ignored untracked file or walk-limit
 *   overflow fails closed to unknown).
 * - Remaining read-only object/ref queries (`for-each-ref`, `rev-list`,
 *   `ls-tree`, `merge-base`) run asynchronously with a sanitized environment
 *   (dropping inherited `GIT_*` overrides), hardened CLI flags, a shared
 *   monotonic deadline, and bounded `SIGTERM` -> `SIGKILL` termination.
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
}

export type GitRunner = (
  gitDir: string,
  args: readonly string[],
  options?: GitRunOptions,
) => Promise<string | undefined> | string | undefined;

const TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 150;
const MAX_GIT_STDOUT = 16 * 1024 * 1024;
export const DEFAULT_WORKTREE_BUDGET_MS = 2_000;
const POINTER_MAX_BYTES = 4096;
const CONFIG_MAX_BYTES = 64 * 1024;
const REFLOG_MAX_BYTES = 256 * 1024;
const PACKED_REFS_MAX_BYTES = 8 * 1024 * 1024;
const IGNORE_MAX_BYTES = 64 * 1024;
const CLEAN_INDEX_MAX_BYTES = 32 * 1024 * 1024;
const CLEAN_INDEX_MAX_ENTRIES = 100_000;
const MAX_HASH_FILE_BYTES = 1024 * 1024;
const MAX_HASH_WORKTREE_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_WALK_ENTRIES = 10_000;
const MAX_UNTRACKED_WALK_DEPTH = 64;
const FIRST_PARENT_MAX_COMMITS = 5_000;

const HEADS = "refs/heads/";
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

function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform !== "win32" && proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fall through to direct child kill.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Child already exited.
  }
}

function terminateChildBounded(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  killProcessTree(proc, "SIGTERM");
  const force = setTimeout(() => {
    killProcessTree(proc, "SIGKILL");
  }, KILL_GRACE_MS);
  force.unref();
  proc.once("close", () => clearTimeout(force));
}

export function createGitRunner(gitBinary = "git"): GitRunner {
  return (gitDir, args, options) => {
    if (options?.signal?.aborted) return Promise.resolve(undefined);
    const timeout = Math.max(1, Math.min(TIMEOUT_MS, options?.timeoutMs ?? TIMEOUT_MS));
    const gitArgs = [...gitSafeArgs(), `--git-dir=${gitDir}`, ...args];

    return new Promise<string | undefined>((resolvePromise) => {
      let settled = false;
      let timedOutOrAborted = false;
      let stdoutBytes = 0;
      const chunks: Buffer[] = [];

      let proc: ChildProcess;
      try {
        proc = spawn(gitBinary, gitArgs, {
          env: gitEnv(),
          stdio: ["ignore", "pipe", "ignore"],
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

      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(value);
      };

      const onCancel = () => {
        timedOutOrAborted = true;
        terminateChildBounded(proc);
      };

      const timer = setTimeout(onCancel, timeout);
      timer.unref();
      options?.signal?.addEventListener("abort", onCancel, { once: true });
      if (options?.signal?.aborted) onCancel();

      proc.stdout?.on("data", (chunk: Buffer) => {
        if (settled || timedOutOrAborted) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_GIT_STDOUT) {
          timedOutOrAborted = true;
          terminateChildBounded(proc);
          return;
        }
        chunks.push(chunk);
      });

      proc.stdout?.on("error", () => {
        timedOutOrAborted = true;
        terminateChildBounded(proc);
      });

      proc.on("error", () => {
        finish(undefined);
      });

      proc.on("close", (code, signal) => {
        if (timedOutOrAborted || code !== 0 || signal !== null) {
          finish(undefined);
          return;
        }
        finish(Buffer.concat(chunks).toString("utf8"));
      });
    });
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
  const line = pointer.split(/\r?\n/, 1)[0] ?? "";
  if (!line.startsWith("gitdir:")) return undefined;
  const target = line.slice(7).trim();
  if (!target) return undefined;
  const rawGitDir = isAbsolute(target) ? target : resolve(realRoot, target);
  const gitDir = canonicalPath(rawGitDir);
  if (!gitDir) return undefined;
  // Only a linked worktree has `commondir`; a submodule's git dir does not.
  const commondir = readSmallText(resolve(gitDir, "commondir"), POINTER_MAX_BYTES)?.trim();
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
 * Read the current commit OID of `refs/heads/<branch>` directly from the loose
 * ref or `packed-refs` (no git spawn, never stale).
 */
function readBranchTipOid(common: string, branch: string): string | undefined {
  const segments = splitSafeRefSegments(branch);
  if (!segments) return undefined;

  const loose = readContainedGitMetaFile(common, ["refs", "heads"], segments, POINTER_MAX_BYTES);
  if (loose.status === "ok") {
    const val = loose.text.trim();
    return HEX_OID.test(val) ? val : undefined;
  }
  if (loose.status === "rejected") return undefined;

  // Loose ref missing; check `<common>/packed-refs`.
  const packed = readSmallText(resolve(common, "packed-refs"), PACKED_REFS_MAX_BYTES);
  if (!packed) return undefined;
  const targetRef = `${HEADS}${branch}`;
  for (const line of packed.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space < 40) continue;
    const oid = line.slice(0, space);
    const ref = line.slice(space + 1).trim();
    if (ref === targetRef) {
      return HEX_OID.test(oid) ? oid : undefined;
    }
  }
  return undefined;
}

type ReflogEvidence =
  | { kind: "proven"; ownCommitOid: string }
  | { kind: "disproven" }
  | { kind: "missing" };

/**
 * Inspect `<common>/logs/refs/heads/<branch>` for affirmative branch-specific
 * evidence of a commit authored on this branch reaching `tipOid`.
 *
 * - Returns `missing` only when the reflog file genuinely does not exist.
 * - Returns `disproven` when a reflog exists (or fails path validation) and
 *   shows no surviving own commit at `tipOid` (e.g. creation-only or reset).
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

function hasConfiguredOriginRemote(common: string): boolean {
  const configPath = resolve(common, "config");
  try {
    const meta = lstatSync(configPath);
    if (meta.isSymbolicLink() || !meta.isFile()) return true; // fail closed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
  const text = readSmallText(configPath, CONFIG_MAX_BYTES);
  if (text === undefined) return true; // oversized/unreadable -> fail closed
  return /^\s*\[remote\s+"origin"\]/m.test(text);
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

function gitBlobOidHex(content: Buffer, hashLen: 20 | 32): string {
  const alg = hashLen === 20 ? "sha1" : "sha256";
  return createHash(alg).update(`blob ${content.length}\0`).update(content).digest("hex");
}

function verifyTrackedEntry(
  realRoot: string,
  entry: GitIndexEntry,
  indexStat: BigIntStats,
  hashLen: 20 | 32,
  hashBudget: { remainingBytes: number },
): boolean {
  // Reject non-zero merge stage, assume-unchanged, and any extended flags
  // (skip-worktree, intent-to-add, etc.).
  const stage = (entry.flags >> 12) & 0x3;
  if (stage !== 0 || (entry.flags & 0x8000) !== 0 || entry.extFlags !== 0) {
    return false;
  }

  // Validate relative path safety.
  const segments = splitSafeRefSegments(entry.path);
  if (!segments) return false;

  const fileType = entry.mode & 0o170000;
  // Reject gitlinks / submodules (0o160000) and any non-file/non-symlink type.
  if (fileType !== 0o100000 && fileType !== 0o120000) {
    return false;
  }

  const absPath = join(realRoot, ...segments);
  let stat: BigIntStats;
  try {
    stat = lstatSync(absPath, { bigint: true });
  } catch {
    return false;
  }

  if (fileType === 0o120000) {
    if (!stat.isSymbolicLink()) return false;
    try {
      const target = readlinkSync(absPath, "buffer");
      return gitBlobOidHex(target, hashLen) === entry.oidHex;
    } catch {
      return false;
    }
  }

  // Regular file (`0o100644` or `0o100755`).
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  if (process.platform !== "win32") {
    const indexExec = (entry.mode & 0o100) !== 0;
    const diskExec = (Number(stat.mode) & 0o100) !== 0;
    if (indexExec !== diskExec) return false;
  }
  if (stat.size > 0xffffffffn || stat.size !== BigInt(entry.size)) return false;

  const mtimeSec = Number((stat.mtimeNs / 1_000_000_000n) & 0xffffffffn);
  const mtimeNsec = Number(stat.mtimeNs % 1_000_000_000n);
  const ctimeSec = Number((stat.ctimeNs / 1_000_000_000n) & 0xffffffffn);
  const ctimeNsec = Number(stat.ctimeNs % 1_000_000_000n);

  if (entry.mtimeSec === 0 || mtimeSec !== entry.mtimeSec) return false;
  if (process.platform !== "win32") {
    if (entry.mtimeNsec !== 0 && mtimeNsec !== entry.mtimeNsec) return false;
    if (entry.ino !== 0 && Number(stat.ino & 0xffffffffn) !== entry.ino) return false;
    if (entry.dev !== 0 && Number(stat.dev & 0xffffffffn) !== entry.dev) return false;
    if (entry.ctimeSec !== 0 && ctimeSec !== entry.ctimeSec) return false;
    if (entry.ctimeNsec !== 0 && ctimeNsec !== entry.ctimeNsec) return false;
  }

  const indexMtimeSec = Number((indexStat.mtimeNs / 1_000_000_000n) & 0xffffffffn);
  const indexMtimeNsec = Number(indexStat.mtimeNs % 1_000_000_000n);
  const isRacy =
    entry.mtimeSec > indexMtimeSec ||
    (entry.mtimeSec === indexMtimeSec &&
      (entry.mtimeNsec === 0 || entry.mtimeNsec >= indexMtimeNsec));
  const needsHashCheck =
    isRacy ||
    (process.platform === "win32" && entry.mtimeNsec !== 0 && mtimeNsec !== entry.mtimeNsec);

  if (!needsHashCheck) return true;

  // Racily-clean (same second as index) or Windows sub-second rounding: verify
  // exact blob OID up to bounded limits.
  const fileSize = Number(stat.size);
  if (fileSize > MAX_HASH_FILE_BYTES || fileSize > hashBudget.remainingBytes) return false;
  const content = readSmallFile(absPath, MAX_HASH_FILE_BYTES);
  if (!content || content.bytes.length !== fileSize) return false;
  hashBudget.remainingBytes -= fileSize;
  return gitBlobOidHex(content.bytes, hashLen) === entry.oidHex;
}

// ── Bounded `.gitignore` / `info/exclude` matcher ─────────────────────────────

interface IgnoreRule {
  baseDir: string; // "" for repo root, or "a/b" (no leading/trailing slash)
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

function globToRegexSource(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) {
      out += escapeRegExpChar(pattern[i + 1]!);
      i += 2;
      continue;
    }
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `/**/` or `**/` or `/**` or `**`
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close > i + 1) {
        let body = pattern.slice(i + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, "\\\\")}]`;
        i = close + 1;
        continue;
      }
    }
    out += escapeRegExpChar(ch);
    i += 1;
  }
  return out;
}

function escapeRegExpChar(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function parseIgnoreFile(text: string, baseDir: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // Strip unescaped trailing spaces.
    let line = rawLine;
    while (line.endsWith(" ") && !line.endsWith("\\ ")) {
      line = line.slice(0, -1);
    }
    if (!line || line.startsWith("#")) continue;

    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith("\\#") || line.startsWith("\\!")) {
      line = line.slice(1);
    }
    if (!line) continue;

    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;

    let anchored = false;
    if (line.startsWith("/")) {
      anchored = true;
      line = line.slice(1);
    } else if (line.includes("/")) {
      anchored = true;
    }
    if (!line) continue;

    const src = globToRegexSource(line);
    const regex = anchored ? new RegExp(`^${src}$`) : new RegExp(`(?:^|/)${src}$`);
    rules.push({ baseDir, negated, dirOnly, anchored, regex });
  }
  return rules;
}

function loadIgnoreRules(filePath: string, baseDir: string): IgnoreRule[] | null {
  try {
    const meta = lstatSync(filePath);
    if (meta.isSymbolicLink() || !meta.isFile()) return null; // fail closed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return null;
  }
  const text = readSmallText(filePath, IGNORE_MAX_BYTES);
  if (text === undefined) return null;
  return parseIgnoreFile(text, baseDir);
}

function isPathIgnored(relPath: string, isDir: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    let subject: string;
    if (rule.baseDir === "") {
      subject = relPath;
    } else if (relPath.startsWith(`${rule.baseDir}/`)) {
      subject = relPath.slice(rule.baseDir.length + 1);
    } else {
      continue;
    }
    if (rule.regex.test(subject)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

interface TreeEntry {
  mode: number;
  oidHex: string;
  path: string;
}

function parseLsTreeOutput(stdout: string): TreeEntry[] | null {
  const entries: TreeEntry[] = [];
  if (stdout.length === 0) return entries;
  const records = stdout.split("\0");
  for (const record of records) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) return null;
    const meta = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (meta.length !== 3 || !path) return null;
    const [modeStr = "", type = "", oidHex = ""] = meta;
    // Reject submodules / gitlinks (`160000 commit ...`).
    if (type !== "blob" || !HEX_OID.test(oidHex)) return null;
    const mode = Number.parseInt(modeStr, 8);
    if (!Number.isFinite(mode)) return null;
    entries.push({ mode, oidHex, path });
  }
  return entries;
}

function indexMatchesTree(entries: readonly GitIndexEntry[], tree: readonly TreeEntry[]): boolean {
  if (entries.length !== tree.length) return false;
  const byPath = new Map<string, TreeEntry>();
  for (const t of tree) byPath.set(t.path, t);
  if (byPath.size !== tree.length) return false;
  for (const entry of entries) {
    const match = byPath.get(entry.path);
    if (!match || match.mode !== entry.mode || match.oidHex !== entry.oidHex) {
      return false;
    }
  }
  return true;
}

export class WorktreeIndex {
  private readonly projects = new Map<string, Promise<WorktreeInfo | undefined>>();
  private readonly repos = new Map<string, Promise<RepoBranches | undefined>>();
  private readonly trees = new Map<string, Promise<TreeEntry[] | null>>();
  private readonly git: GitRunner;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly signal: AbortSignal | undefined;

  constructor(git?: GitRunner, options: WorktreeIndexOptions = {}) {
    this.git = git ?? createGitRunner(options.gitBinary);
    this.now = options.now ?? (() => performance.now());
    const budgetMs = Math.max(0, options.budgetMs ?? DEFAULT_WORKTREE_BUDGET_MS);
    this.deadlineMs = this.now() + budgetMs;
    this.signal = options.signal;
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

  private async runBoundedGit(
    gitDir: string,
    args: readonly string[],
  ): Promise<string | undefined> {
    const remaining = this.remainingBudgetMs();
    if (remaining <= 0) return undefined;
    const timeoutMs = Math.min(TIMEOUT_MS, remaining);
    return await this.git(
      gitDir,
      args,
      this.signal ? { timeoutMs, signal: this.signal } : { timeoutMs },
    );
  }

  private async read(root: string): Promise<WorktreeInfo | undefined> {
    const linked = linkedGitDir(root);
    if (!linked) return undefined;
    const { realRoot, gitDir, common, of } = linked;
    const branch = readCheckedOutBranch(gitDir);
    if (!branch) return { of };

    const repo = await this.branches(common);
    if (!repo || branch === repo.base) return { of, branch };

    // Evaluate `upstream_gone` before merge classification (D5): a branch whose
    // tracking ref is missing never reads as finished.
    if (repo.gone.has(branch)) {
      return { of, branch, state: "upstream_gone" };
    }

    const tipOid = repo.merged.get(branch);
    if (tipOid === undefined) return { of, branch };

    // Pin branch tip before proof and cleanliness checks so a cached ref scan
    // cannot pair with a newer unmerged commit.
    if (readBranchTipOid(common, branch) !== tipOid) {
      return { of, branch };
    }

    if (!(await this.isProvenMerged(common, branch, tipOid, repo))) {
      return { of, branch };
    }

    if (!(await this.isWorktreeClean(common, gitDir, realRoot, tipOid))) {
      return { of, branch };
    }

    // Re-verify HEAD branch and tip OID after cleanliness check to close
    // concurrent commit/switch races.
    if (readCheckedOutBranch(gitDir) !== branch || readBranchTipOid(common, branch) !== tipOid) {
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
    if (!repo.baseRef || !repo.baseOid) return false;
    const reflog = checkBranchReflog(common, branch, tipOid);
    if (reflog.kind === "disproven") return false;
    if (reflog.kind === "proven") {
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

    // Reflog file is genuinely absent (`missing`): only a merge commit whose
    // non-first parent brought `tipOid` into `baseOid` can serve as DAG proof,
    // and never when `tipOid === baseOid`.
    if (tipOid === repo.baseOid) return false;
    return await this.isMergedOutsideFirstParent(common, tipOid, repo.baseOid);
  }

  private async isMergedOutsideFirstParent(
    common: string,
    tipOid: string,
    baseOid: string,
  ): Promise<boolean> {
    const out = await this.runBoundedGit(common, [
      "rev-list",
      "--first-parent",
      "--parents",
      `--max-count=${FIRST_PARENT_MAX_COMMITS}`,
      `${tipOid}..${baseOid}`,
    ]);
    if (out === undefined) return false;
    const lines = out.split("\n").filter((line) => line.length > 0);
    // Empty or truncated history cannot prove the branch is off first-parent.
    if (lines.length === 0 || lines.length >= FIRST_PARENT_MAX_COMMITS) return false;
    const oldest = lines[lines.length - 1] ?? "";
    const firstParent = oldest.split(" ")[1];
    return firstParent !== tipOid;
  }

  private treeEntries(common: string, tipOid: string): Promise<TreeEntry[] | null> {
    const key = `${common}\0${tipOid}`;
    const cached = this.trees.get(key);
    if (cached !== undefined) return cached;
    const pending = this.readTreeEntries(common, tipOid);
    this.trees.set(key, pending);
    return pending;
  }

  private async readTreeEntries(common: string, tipOid: string): Promise<TreeEntry[] | null> {
    const out = await this.runBoundedGit(common, ["ls-tree", "-r", "-z", tipOid]);
    if (out === undefined) return null;
    return parseLsTreeOutput(out);
  }

  /**
   * Data-only cleanliness check (no `git status` spawn):
   * 1. Rejects any in-progress git operation markers in `gitDir`.
   * 2. Parses `<gitDir>/index` directly and rejects unsupported layouts
   *    (split/sparse/unknown extensions/versions), gitlinks/submodules, and
   *    suppressing flags (`assume-unchanged`, `skip-worktree`, `intent-to-add`,
   *    unmerged stages).
   * 3. Verifies every tracked entry against `lstat` (plus bounded blob-hash
   *    check for racily-clean entries).
   * 4. Compares parsed index entries against `ls-tree -r -z <tipOid>` to catch
   *    staged changes without reading repo config or touching the worktree.
   * 5. Walks the worktree boundedly, honoring `.gitignore` and
   *    `<common>/info/exclude`; any non-ignored untracked file or walk-limit
   *    overflow fails closed (returns `false`).
   */
  private async isWorktreeClean(
    common: string,
    gitDir: string,
    realRoot: string,
    tipOid: string,
  ): Promise<boolean> {
    if (this.remainingBudgetMs() <= 0) return false;
    if (hasInProgressOperation(gitDir)) return false;

    const hashLen: 20 | 32 | undefined =
      tipOid.length === 40 ? 20 : tipOid.length === 64 ? 32 : undefined;
    if (!hashLen) return false;

    const indexPath = join(gitDir, "index");
    let indexEntries: GitIndexEntry[];
    let indexStat: BigIntStats | undefined;

    try {
      lstatSync(indexPath);
      const indexFile = readSmallFile(indexPath, CLEAN_INDEX_MAX_BYTES);
      if (!indexFile) return false;
      indexStat = indexFile.stat;
      const parsed = parseGitIndex(indexFile.bytes, hashLen, {
        allowSplitIndex: false,
        maxEntries: CLEAN_INDEX_MAX_ENTRIES,
      });
      if (!parsed.ok) return false;
      indexEntries = parsed.entries;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        indexEntries = [];
      } else {
        return false;
      }
    }

    const trackedPaths = new Set<string>();
    const trackedDirs = new Set<string>();
    const hashBudget = { remainingBytes: MAX_HASH_WORKTREE_BYTES };

    for (const entry of indexEntries) {
      if (this.remainingBudgetMs() <= 0) return false;
      if (!indexStat || !verifyTrackedEntry(realRoot, entry, indexStat, hashLen, hashBudget)) {
        return false;
      }
      trackedPaths.add(entry.path);
      let slash = entry.path.indexOf("/");
      while (slash >= 0) {
        trackedDirs.add(entry.path.slice(0, slash));
        slash = entry.path.indexOf("/", slash + 1);
      }
    }

    // Bounded untracked-file walk honoring `<common>/info/exclude` and `.gitignore`.
    if (!this.hasNoUntrackedFiles(realRoot, common, trackedPaths, trackedDirs)) {
      return false;
    }

    // Verify staged state matches `tipOid` tree exactly.
    const tree = await this.treeEntries(common, tipOid);
    if (!tree || !indexMatchesTree(indexEntries, tree)) return false;

    return true;
  }

  private hasNoUntrackedFiles(
    realRoot: string,
    common: string,
    trackedPaths: ReadonlySet<string>,
    trackedDirs: ReadonlySet<string>,
  ): boolean {
    const excludeRules = loadIgnoreRules(join(common, "info", "exclude"), "");
    if (excludeRules === null) return false;

    let seenEntries = 0;

    const walk = (
      absDir: string,
      relDir: string,
      depth: number,
      inheritedRules: IgnoreRule[],
    ): boolean => {
      if (depth > MAX_UNTRACKED_WALK_DEPTH || this.remainingBudgetMs() <= 0) return false;

      const localIgnore = loadIgnoreRules(join(absDir, ".gitignore"), relDir);
      if (localIgnore === null) return false;
      const rules = localIgnore.length > 0 ? [...inheritedRules, ...localIgnore] : inheritedRules;

      let dirents;
      try {
        dirents = readdirSync(absDir, { withFileTypes: true });
      } catch {
        return false;
      }

      for (const entry of dirents) {
        seenEntries += 1;
        if (seenEntries > MAX_UNTRACKED_WALK_ENTRIES) return false;
        if (seenEntries % 256 === 0 && this.remainingBudgetMs() <= 0) return false;

        const name = entry.name;
        if (relDir === "" && name === ".git") continue;
        const rel = relDir ? `${relDir}/${name}` : name;

        if (entry.isDirectory()) {
          // A nested git repo inside the worktree counts as untracked unless ignored.
          if (isPathIgnored(rel, true, rules) && !trackedDirs.has(rel)) {
            continue;
          }
          if (name === ".git") return false;
          if (!walk(join(absDir, name), rel, depth + 1, rules)) return false;
          continue;
        }

        if (entry.isFile() || entry.isSymbolicLink()) {
          if (trackedPaths.has(rel)) continue;
          if (isPathIgnored(rel, false, rules)) continue;
          return false;
        }

        // Any special file (FIFO, socket, device) fails closed.
        return false;
      }
      return true;
    };

    return walk(realRoot, "", 0, excludeRules);
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
    const gone = new Set<string>();
    let originHead: string | undefined;
    let originHeadOid: string | undefined;
    let hasOriginRefs = false;

    for (const line of listing.split("\n")) {
      if (!line) continue;
      const [ref = "", oid = "", track = "", symref = ""] = line.split("\0");
      if (ref === "refs/remotes/origin/HEAD") {
        hasOriginRefs = true;
        if (symref && oid && HEX_OID.test(oid)) {
          originHead = symref;
          originHeadOid = oid;
        }
      } else if (ref.startsWith("refs/remotes/origin/")) {
        hasOriginRefs = true;
      } else if (ref.startsWith(HEADS)) {
        const name = ref.slice(HEADS.length);
        if (oid && HEX_OID.test(oid)) localOids.set(name, oid);
        if (track === "[gone]") gone.add(name);
      }
    }

    // Verified base selection:
    // 1. `refs/remotes/origin/HEAD` when present.
    // 2. If an `origin` remote is configured without `origin/HEAD`, leave base
    //    unknown rather than guessing a local branch.
    // 3. Otherwise (local-only repository), use the branch checked out in the
    //    main worktree (`<common>/HEAD`), never a guessed local `main`/`master`.
    let baseRef: string | undefined;
    let baseOid: string | undefined;
    let base: string | undefined;

    if (originHead && originHeadOid) {
      baseRef = originHead;
      baseOid = originHeadOid;
      base = originHead.startsWith("refs/remotes/origin/")
        ? originHead.slice("refs/remotes/origin/".length)
        : originHead.startsWith(HEADS)
          ? originHead.slice(HEADS.length)
          : undefined;
    } else if (!hasOriginRefs && !hasConfiguredOriginRemote(common)) {
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
    const merged = new Map<string, string>();
    for (const line of mergedOut?.split("\n") ?? []) {
      if (!line) continue;
      const [ref = "", oid = ""] = line.split("\0");
      if (ref.startsWith(HEADS) && oid && HEX_OID.test(oid)) {
        merged.set(ref.slice(HEADS.length), oid);
      }
    }
    return { base, baseRef, baseOid, merged, gone };
  }
}
