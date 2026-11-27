import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Pure read-only parser for Git's binary index file (versions 2, 3, and 4,
 * SHA-1 and SHA-256). Used both for read-only tracked-path checks (including
 * split indexes, without spawning git or updating shared-index mtimes) and for
 * data-only worktree cleanliness verification.
 */

export const DEFAULT_MAX_INDEX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_INDEX_ENTRIES = 500_000;
const MAX_PATH_BYTES = 64 * 1024;
const POINTER_MAX_BYTES = 4096;

/** Benign cache-only index extensions that do not alter the tracked entry set. */
const ALLOWED_CACHE_EXTENSIONS = new Set(["TREE", "REUC", "EOIE", "IEOT", "UNTR", "FSMN"]);

export interface SmallFileResult {
  bytes: Buffer;
  stat: BigIntStats;
}

/**
 * Canonical filesystem path, expanding Windows 8.3 short names and macOS
 * `/tmp` -> `/private/tmp` aliases while stripping Windows `\\?\` prefixes.
 */
export function canonicalPath(path: string): string | undefined {
  try {
    const real =
      typeof realpathSync.native === "function" ? realpathSync.native(path) : realpathSync(path);
    if (process.platform !== "win32") return real;
    if (real.startsWith("\\\\?\\UNC\\")) return `\\\\${real.slice(8)}`;
    if (real.startsWith("\\\\?\\")) return real.slice(4);
    return real;
  } catch {
    return undefined;
  }
}

/**
 * Open and read a bounded regular file without following symlinks or blocking
 * on FIFOs. Returns `undefined` if missing, a symlink, non-regular, or larger
 * than `maxBytes`.
 */
export function readSmallFile(
  path: string,
  maxBytes = POINTER_MAX_BYTES,
): SmallFileResult | undefined {
  let fd: number | undefined;
  try {
    const lmeta = lstatSync(path);
    if (!lmeta.isFile() || lmeta.isSymbolicLink() || lmeta.size > maxBytes) return undefined;
    const flags =
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    fd = openSync(path, flags);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(maxBytes)) return undefined;
    const expected = Number(stat.size);
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, expected + 1));
    let total = 0;
    while (total <= maxBytes) {
      const remaining = buffer.length - total;
      if (remaining === 0) {
        // File grew between fstat and read; verify if EOF or oversized.
        const probe = Buffer.allocUnsafe(1);
        const n = readSync(fd, probe, 0, 1, null);
        if (n === 0) break;
        return undefined;
      }
      const n = readSync(fd, buffer, total, remaining, null);
      if (n === 0) break;
      total += n;
    }
    if (total > maxBytes) return undefined;
    return { bytes: buffer.subarray(0, total), stat };
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

export function readSmallText(path: string, maxBytes = POINTER_MAX_BYTES): string | undefined {
  return readSmallFile(path, maxBytes)?.bytes.toString("utf8");
}

export interface GitIndexEntry {
  ctimeSec: number;
  ctimeNsec: number;
  mtimeSec: number;
  mtimeNsec: number;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  oidHex: string;
  flags: number;
  extFlags: number;
  path: string;
}

export interface SplitIndexLink {
  baseOidHex: string;
  deleteBitmap: Set<number>;
  replaceBitmap: Set<number>;
}

export type ParseIndexResult =
  | {
      ok: true;
      version: number;
      hashLen: 20 | 32;
      entries: GitIndexEntry[];
      splitLink?: SplitIndexLink;
    }
  | { ok: false; reason: string };

export interface ParseIndexOptions {
  allowSplitIndex?: boolean;
  maxEntries?: number;
}

class BufferReader {
  at = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.at;
  }

  take(n: number): Buffer | undefined {
    if (n < 0 || this.at + n > this.buf.length) return undefined;
    const slice = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return slice;
  }

  u16(): number | undefined {
    if (this.at + 2 > this.buf.length) return undefined;
    const val = this.buf.readUInt16BE(this.at);
    this.at += 2;
    return val;
  }

  u32(): number | undefined {
    if (this.at + 4 > this.buf.length) return undefined;
    const val = this.buf.readUInt32BE(this.at);
    this.at += 4;
    return val;
  }

  u64BigInt(): bigint | undefined {
    if (this.at + 8 > this.buf.length) return undefined;
    const val = this.buf.readBigUInt64BE(this.at);
    this.at += 8;
    return val;
  }

  untilNul(): Buffer | undefined {
    const limit = Math.min(this.buf.length, this.at + MAX_PATH_BYTES + 1);
    const nul = this.buf.indexOf(0, this.at);
    if (nul < 0 || nul >= limit) return undefined;
    const slice = this.buf.subarray(this.at, nul);
    this.at = nul + 1;
    return slice;
  }

  /** Git's offset varint used for index v4 path prefix lengths. */
  varint(): number | undefined {
    const first = this.take(1);
    if (!first) return undefined;
    let byte = first[0]!;
    let value = byte & 0x7f;
    while ((byte & 0x80) !== 0) {
      const next = this.take(1);
      if (!next) return undefined;
      byte = next[0]!;
      value = (value + 1) * 128 + (byte & 0x7f);
      if (!Number.isSafeInteger(value) || value > MAX_PATH_BYTES) return undefined;
    }
    return value;
  }
}

/** Decode Git's EWAH-compressed bitmap used in the `link` split-index extension. */
function readEwahBitmap(reader: BufferReader, maxBits: number): Set<number> | undefined {
  const bitSize = reader.u32();
  const wordCount = reader.u32();
  if (bitSize === undefined || wordCount === undefined || bitSize > maxBits) return undefined;

  const setBits = new Set<number>();
  let wordsRead = 0;
  let bitPos = 0;

  while (wordsRead < wordCount) {
    const rlw = reader.u64BigInt();
    if (rlw === undefined) return undefined;
    wordsRead += 1;

    const runningBit = (rlw & 1n) !== 0n;
    const runningWords = Number((rlw >> 1n) & 0xffffffffn);
    const literalWords = Number(rlw >> 33n);

    if (runningWords < 0 || literalWords < 0 || wordsRead + literalWords > wordCount) {
      return undefined;
    }

    const runningBits = runningWords * 64;
    if (runningBit) {
      const end = Math.min(bitSize, bitPos + runningBits);
      for (let i = bitPos; i < end; i++) setBits.add(i);
    }
    bitPos += runningBits;

    for (let w = 0; w < literalWords; w++) {
      const word = reader.u64BigInt();
      if (word === undefined) return undefined;
      wordsRead += 1;
      if (word !== 0n) {
        const limit = Math.min(64, Math.max(0, bitSize - bitPos));
        for (let b = 0; b < limit; b++) {
          if (((word >> BigInt(b)) & 1n) !== 0n) setBits.add(bitPos + b);
        }
      }
      bitPos += 64;
    }
  }

  // Trailing rlw_pos u32.
  if (reader.u32() === undefined) return undefined;
  return setBits;
}

function parseSplitLinkExtension(
  body: Buffer,
  hashLen: 20 | 32,
  maxEntries: number,
): SplitIndexLink | undefined {
  const reader = new BufferReader(body);
  const baseOid = reader.take(hashLen);
  if (!baseOid) return undefined;
  const baseOidHex = baseOid.toString("hex");
  if (reader.remaining === 0) {
    return { baseOidHex, deleteBitmap: new Set(), replaceBitmap: new Set() };
  }
  const deleteBitmap = readEwahBitmap(reader, maxEntries);
  if (!deleteBitmap) return undefined;
  const replaceBitmap = readEwahBitmap(reader, maxEntries);
  if (!replaceBitmap) return undefined;
  if (reader.remaining !== 0) return undefined;
  return { baseOidHex, deleteBitmap, replaceBitmap };
}

/** Parse a Git binary index buffer for a known hash length (20 = SHA-1, 32 = SHA-256). */
export function parseGitIndex(
  bytes: Buffer,
  hashLen: 20 | 32,
  options: ParseIndexOptions = {},
): ParseIndexResult {
  const allowSplitIndex = options.allowSplitIndex ?? false;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_INDEX_ENTRIES;
  const reader = new BufferReader(bytes);

  const magic = reader.take(4);
  if (!magic || magic.toString("ascii") !== "DIRC") {
    return { ok: false, reason: "bad-magic" };
  }
  const version = reader.u32();
  if (version === undefined || version < 2 || version > 4) {
    return { ok: false, reason: "unsupported-version" };
  }
  const count = reader.u32();
  if (count === undefined || count > maxEntries) {
    return { ok: false, reason: "too-many-entries" };
  }

  const entries: GitIndexEntry[] = [];
  let previousPath: Buffer = Buffer.alloc(0);

  for (let i = 0; i < count; i++) {
    const start = reader.at;
    const ctimeSec = reader.u32();
    const ctimeNsec = reader.u32();
    const mtimeSec = reader.u32();
    const mtimeNsec = reader.u32();
    const dev = reader.u32();
    const ino = reader.u32();
    const mode = reader.u32();
    const uid = reader.u32();
    const gid = reader.u32();
    const size = reader.u32();
    const oid = reader.take(hashLen);
    const flags = reader.u16();
    if (
      ctimeSec === undefined ||
      ctimeNsec === undefined ||
      mtimeSec === undefined ||
      mtimeNsec === undefined ||
      dev === undefined ||
      ino === undefined ||
      mode === undefined ||
      uid === undefined ||
      gid === undefined ||
      size === undefined ||
      !oid ||
      flags === undefined
    ) {
      return { ok: false, reason: "truncated-entry" };
    }

    let extFlags = 0;
    const extended = (flags & 0x4000) !== 0;
    if (extended) {
      if (version < 3) return { ok: false, reason: "extended-in-v2" };
      const ext = reader.u16();
      if (ext === undefined) return { ok: false, reason: "truncated-ext-flags" };
      extFlags = ext;
    }

    const nameLen = flags & 0x0fff;
    let pathBytes: Buffer;
    if (version === 4) {
      const strip = reader.varint();
      const suffix = reader.untilNul();
      if (strip === undefined || !suffix || strip > previousPath.length) {
        return { ok: false, reason: "bad-v4-path" };
      }
      const keep = previousPath.length - strip;
      pathBytes = Buffer.concat([previousPath.subarray(0, keep), suffix]);
    } else {
      const name = reader.untilNul();
      if (!name) return { ok: false, reason: "unterminated-path" };
      if (nameLen < 0x0fff && name.length !== nameLen) {
        return { ok: false, reason: "path-len-mismatch" };
      }
      const fixed = reader.at - start - name.length - 1;
      const padded = (fixed + name.length + 8) & ~7;
      const pad = padded - (reader.at - start);
      const padding = reader.take(pad);
      if (!padding || padding.some((b) => b !== 0)) {
        return { ok: false, reason: "bad-padding" };
      }
      pathBytes = name;
    }

    if (pathBytes.length > MAX_PATH_BYTES) return { ok: false, reason: "path-too-long" };
    if (pathBytes.length === 0 && !allowSplitIndex) {
      return { ok: false, reason: "empty-path" };
    }
    previousPath = pathBytes;
    entries.push({
      ctimeSec,
      ctimeNsec,
      mtimeSec,
      mtimeNsec,
      dev,
      ino,
      mode,
      uid,
      gid,
      size,
      oidHex: oid.toString("hex"),
      flags,
      extFlags,
      path: pathBytes.toString("utf8"),
    });
  }

  let splitLink: SplitIndexLink | undefined;
  while (reader.remaining > hashLen) {
    const sigBuf = reader.take(4);
    const extSize = reader.u32();
    if (!sigBuf || extSize === undefined) return { ok: false, reason: "truncated-extension" };
    const sig = sigBuf.toString("ascii");
    const body = reader.take(extSize);
    if (!body) return { ok: false, reason: "truncated-extension-body" };
    if (sig === "link") {
      if (!allowSplitIndex) return { ok: false, reason: "split-index" };
      const parsedLink = parseSplitLinkExtension(body, hashLen, maxEntries);
      if (!parsedLink) return { ok: false, reason: "bad-split-link" };
      splitLink = parsedLink;
    } else if (sig === "sdir") {
      return { ok: false, reason: "sparse-index" };
    } else if (!ALLOWED_CACHE_EXTENSIONS.has(sig)) {
      return { ok: false, reason: `unknown-extension:${sig}` };
    }
  }

  if (reader.remaining !== hashLen) {
    return { ok: false, reason: "bad-trailing-checksum" };
  }
  if (entries.some((entry) => entry.path.length === 0) && !splitLink) {
    return { ok: false, reason: "empty-path-without-split-link" };
  }

  return {
    ok: true,
    version,
    hashLen,
    entries,
    ...(splitLink ? { splitLink } : {}),
  };
}

/** Resolve the index file path for a repository worktree (main or linked). */
export function resolveRepoIndexFile(root: string): string | undefined {
  const realRoot = canonicalPath(root);
  if (!realRoot) return undefined;
  const dotGit = join(realRoot, ".git");
  try {
    const meta = lstatSync(dotGit);
    if (meta.isDirectory()) return join(dotGit, "index");
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size > POINTER_MAX_BYTES) return undefined;
  } catch {
    return undefined;
  }
  const pointer = readSmallText(dotGit, POINTER_MAX_BYTES);
  if (pointer === undefined) return undefined;
  const firstLine = pointer.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith("gitdir:")) return undefined;
  const target = firstLine.slice(7).trim();
  if (!target) return undefined;
  const gitDir = isAbsolute(target) ? target : resolve(realRoot, target);
  return join(gitDir, "index");
}

function parseAutoHash(bytes: Buffer, options: ParseIndexOptions): ParseIndexResult {
  const sha1 = parseGitIndex(bytes, 20, options);
  if (sha1.ok) return sha1;
  return parseGitIndex(bytes, 32, options);
}

/**
 * Read tracked paths directly from a repository's index without spawning git
 * or touching shared-index mtimes. Returns `null` when the index layout is
 * unsupported so callers can fall back conservatively.
 */
export function readTrackedPathsFromIndex(root: string): string[] | null {
  const indexPath = resolveRepoIndexFile(root);
  if (!indexPath) return null;

  try {
    lstatSync(indexPath);
  } catch (err) {
    // No index yet: nothing staged or committed.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return null;
  }

  const file = readSmallFile(indexPath, DEFAULT_MAX_INDEX_BYTES);
  if (!file) return null;

  const parsed = parseAutoHash(file.bytes, { allowSplitIndex: true });
  if (!parsed.ok) return null;

  if (!parsed.splitLink) {
    const unique = [...new Set(parsed.entries.map((e) => e.path))];
    unique.sort();
    return unique;
  }

  const { baseOidHex, deleteBitmap, replaceBitmap } = parsed.splitLink;
  const allPaths: string[] = [];

  if (!/^0+$/.test(baseOidHex)) {
    const sharedPath = join(dirname(indexPath), `sharedindex.${baseOidHex}`);
    const sharedFile = readSmallFile(sharedPath, DEFAULT_MAX_INDEX_BYTES);
    if (!sharedFile) return null;
    const baseParsed = parseGitIndex(sharedFile.bytes, parsed.hashLen, {
      allowSplitIndex: false,
    });
    if (!baseParsed.ok) return null;
    for (let i = 0; i < baseParsed.entries.length; i++) {
      if (deleteBitmap.has(i)) continue;
      // Replaced entries keep the base entry's path; untouched entries keep it too.
      if (replaceBitmap.has(i) || !deleteBitmap.has(i)) {
        allPaths.push(baseParsed.entries[i]!.path);
      }
    }
  }

  for (const entry of parsed.entries) {
    if (entry.path.length > 0) allPaths.push(entry.path);
  }

  const unique = [...new Set(allPaths)];
  unique.sort();
  return unique;
}
