import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Identity of the native engine file that passed sweep's checks.
 *
 * Destructive apply spawns the engine by path after asking it for its
 * capabilities. A path is not a program: the file behind it can change
 * between the check and the spawn. Every destructive spawn therefore
 * re-verifies this identity first, and on Linux confirms the running process
 * image is this same file before any plan is sent.
 */
export interface EngineIdentity {
  /** Fully resolved path; destructive spawns use it so link swaps cannot redirect them. */
  path: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  /** SHA-256 of the file contents, computed once per stat identity. */
  sha256: string;
  /** False for `#!` scripts (dev/test engines): the process image is their interpreter. */
  nativeImage: boolean;
}

export type EngineIdentityIssue = "untrusted" | "changed" | "unreadable";

export class EngineIdentityError extends Error {
  constructor(
    message: string,
    readonly issue: EngineIdentityIssue,
  ) {
    super(message);
    this.name = "EngineIdentityError";
  }
}

/** Native engines are a few MB; refuse to hash something absurd. */
const MAX_ENGINE_BYTES = 256 * 1024 * 1024;
const HASH_CHUNK = 1024 * 1024;

type StatIdentity = Pick<EngineIdentity, "path" | "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">;

function statIdentity(path: string, stat: BigIntStats): StatIdentity {
  return {
    path,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

export function sameEngineFile(a: StatIdentity, b: StatIdentity): boolean {
  return (
    a.path === b.path &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

/** Same open file description, ignoring the path (used for process images). */
function sameInode(a: StatIdentity, b: StatIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function statKey(id: StatIdentity): string {
  return `${id.path}\0${id.dev}\0${id.ino}\0${id.size}\0${id.mtimeNs}\0${id.ctimeNs}`;
}

/** Who may own the engine and its directories, from the effective user's view. */
export interface EngineTrustContext {
  uid: number;
  gid: number | undefined;
  /** `SUDO_UID`, honored only when running as root. */
  sudoUid?: string | undefined;
}

function currentTrustContext(): EngineTrustContext | undefined {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid === undefined) return undefined;
  return { uid, gid: process.getegid?.() ?? process.getgid?.(), sudoUid: process.env.SUDO_UID };
}

/** Owners whose files the engine may run from: you, root, and under sudo the invoking user. */
export function trustedEngineOwners(context: EngineTrustContext): ReadonlySet<number> {
  const owners = new Set([context.uid, 0]);
  // `sudo sweep` with an engine the invoking user installed: that user could
  // already replace it, and is the person sudo is acting for. Any other uid
  // stays refused. A malformed value is ignored, never widened.
  if (
    context.uid === 0 &&
    context.sudoUid !== undefined &&
    /^(0|[1-9][0-9]{0,9})$/.test(context.sudoUid)
  ) {
    const sudoUid = Number(context.sudoUid);
    if (sudoUid <= 0xffff_ffff) owners.add(sudoUid);
  }
  return owners;
}

type TrustStat = Pick<Stats, "uid" | "gid" | "mode">;

/**
 * POSIX trust for the engine file and every directory above it, matching the
 * config trust rule (`checkPosixTrust`): owned by a trusted owner (see
 * `trustedEngineOwners`), not world-writable, and not group-writable by
 * another group. A sticky directory (such as `/tmp`) only lets other users
 * replace entries they own, so its write bits are allowed. Without this,
 * anyone who can rename entries along the path can swap the program sweep
 * runs for destructive work.
 */
export function engineTrustIssue(
  realPath: string,
  context: EngineTrustContext | undefined = currentTrustContext(),
  stat: (path: string) => TrustStat = lstatSync,
): string | null {
  if (process.platform === "win32" || context === undefined) return null;
  const owners = trustedEngineOwners(context);
  const { gid } = context;
  const check = (path: string, isDirectory: boolean): string | null => {
    const meta = stat(path);
    if (!owners.has(meta.uid)) return `${path} is owned by another user (uid ${meta.uid})`;
    const sticky = isDirectory && (meta.mode & 0o1000) !== 0;
    if (!sticky && (meta.mode & 0o002) !== 0) return `${path} is world-writable`;
    if (!sticky && (meta.mode & 0o020) !== 0 && (gid === undefined || meta.gid !== gid))
      return `${path} is group-writable by another group`;
    return null;
  };
  const fileIssue = check(realPath, false);
  if (fileIssue) return fileIssue;
  for (let dir = dirname(realPath); ; dir = dirname(dir)) {
    const issue = check(dir, true);
    if (issue) return issue;
    if (dirname(dir) === dir) return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve, trust-check, and stat the engine file without hashing it. Cheap
 * enough for every probe and for the re-checks around each destructive spawn.
 */
export function inspectEngineFile(executable: string): StatIdentity {
  let path: string;
  let stat: BigIntStats;
  try {
    path = realpathSync(executable);
    stat = statSync(path, { bigint: true });
  } catch (error) {
    throw new EngineIdentityError(
      `Cannot inspect the native engine at ${executable}: ${describe(error)}`,
      "unreadable",
    );
  }
  if (!stat.isFile())
    throw new EngineIdentityError(
      `The native engine at ${path} is not a regular file`,
      "unreadable",
    );
  let issue: string | null;
  try {
    issue = engineTrustIssue(path);
  } catch (error) {
    throw new EngineIdentityError(
      `Cannot verify who can modify the native engine at ${path}: ${describe(error)}`,
      "unreadable",
    );
  }
  if (issue)
    throw new EngineIdentityError(
      `Refusing to run the native engine because ${issue}. Use --engine js, or reinstall ` +
        "the engine so it and its directories are owned by you or root and not writable by other users",
      "untrusted",
    );
  return statIdentity(path, stat);
}

const hashed = new Map<string, { sha256: string; nativeImage: boolean }>();

/**
 * Inspect the engine and fingerprint its contents. Hashing reads through one
 * descriptor whose stat must match the path both before and after the read, so
 * the digest belongs to the identity it is cached under. Cached per identity:
 * one read per process for an unchanged engine.
 */
export function captureEngineIdentity(executable: string): EngineIdentity {
  const file = inspectEngineFile(executable);
  const key = statKey(file);
  const cached = hashed.get(key);
  if (cached) return { ...file, ...cached };

  let fd: number;
  try {
    fd = openSync(file.path, "r");
  } catch (error) {
    throw new EngineIdentityError(
      `Cannot read the native engine at ${file.path}: ${describe(error)}`,
      "unreadable",
    );
  }
  try {
    const before = statIdentity(file.path, fstatSync(fd, { bigint: true }));
    if (!sameEngineFile(before, file))
      throw new EngineIdentityError(
        `The native engine at ${file.path} changed while it was being verified`,
        "changed",
      );
    if (file.size > BigInt(MAX_ENGINE_BYTES))
      throw new EngineIdentityError(
        `The native engine at ${file.path} is larger than ${MAX_ENGINE_BYTES} bytes`,
        "unreadable",
      );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK);
    let head = "";
    let offset = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, HASH_CHUNK, offset);
      if (read === 0) break;
      if (offset === 0) head = buffer.subarray(0, Math.min(2, read)).toString("latin1");
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
    const after = statIdentity(file.path, fstatSync(fd, { bigint: true }));
    if (BigInt(offset) !== file.size || !sameEngineFile(after, file))
      throw new EngineIdentityError(
        `The native engine at ${file.path} changed while it was being verified`,
        "changed",
      );
    const fingerprint = { sha256: hash.digest("hex"), nativeImage: head !== "#!" };
    if (hashed.size >= 8) hashed.clear();
    hashed.set(key, fingerprint);
    return { ...file, ...fingerprint };
  } catch (error) {
    if (error instanceof EngineIdentityError) throw error;
    throw new EngineIdentityError(
      `Cannot read the native engine at ${file.path}: ${describe(error)}`,
      "unreadable",
    );
  } finally {
    closeSync(fd);
  }
}

function changedError(path: string): EngineIdentityError {
  return new EngineIdentityError(
    `The native engine at ${path} changed after it was verified`,
    "changed",
  );
}

/** Cheap re-check (realpath + stats, no hashing) before a destructive spawn. */
export function assertEngineUnchanged(expected: EngineIdentity): void {
  let current: StatIdentity;
  try {
    current = inspectEngineFile(expected.path);
  } catch (error) {
    if (error instanceof EngineIdentityError && error.issue === "untrusted") throw error;
    throw changedError(expected.path);
  }
  if (!sameEngineFile(current, expected)) throw changedError(expected.path);
}

function readProcessImage(pid: number): StatIdentity | undefined {
  try {
    return statIdentity("", statSync(`/proc/${pid}/exe`, { bigint: true }));
  } catch {
    return undefined;
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Immediately after spawn, before the child receives any work: the path must
 * still be the verified file, and on Linux the child's process image must be
 * that same file (`/proc/<pid>/exe`), which also catches a swap that was
 * reverted around the spawn. macOS and Windows expose no equivalent, so there
 * the window is limited to the spawn call itself.
 */
export function assertSpawnedEngine(pid: number, expected: EngineIdentity): void {
  assertEngineUnchanged(expected);
  if (process.platform !== "linux" || !expected.nativeImage) return;
  const host = readProcessImage(process.pid);
  // Spawn returns after exec, but stay robust if a runtime ever returns
  // early: while the child still shows the host image, wait briefly.
  let image = readProcessImage(pid);
  for (let waited = 0; waited < 200; waited += 5) {
    if (!image || !host || !sameInode(image, host)) break;
    pause(5);
    image = readProcessImage(pid);
  }
  if (!image || !sameInode(image, expected)) throw changedError(expected.path);
}

/** @internal Test seam: forget cached fingerprints. */
export function resetEngineIdentityCacheForTest(): void {
  hashed.clear();
}
