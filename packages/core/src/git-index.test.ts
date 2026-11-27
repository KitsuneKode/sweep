import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitIndex, readTrackedPathsFromIndex } from "./git-index.js";

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [value & 0x7f];
  let v = value >>> 7;
  while (v > 0) {
    v -= 1;
    bytes.push(0x80 | (v & 0x7f));
    v = Math.floor(v / 128);
  }
  bytes.reverse();
  return Buffer.from(bytes);
}

function buildEntry(path: Buffer, version: 2 | 3 | 4, hashLen: 20 | 32, previous: Buffer): Buffer {
  const fixed = Buffer.alloc(40 + hashLen + 2);
  const flags = Math.min(path.length, 0x0fff);
  fixed.writeUInt16BE(flags, 40 + hashLen);
  if (version === 4) {
    let common = 0;
    while (common < previous.length && common < path.length && previous[common] === path[common]) {
      common += 1;
    }
    const strip = previous.length - common;
    return Buffer.concat([fixed, encodeVarint(strip), path.subarray(common), Buffer.from([0])]);
  }
  const body = Buffer.concat([fixed, path]);
  const padded = (body.length + 8) & ~7;
  return Buffer.concat([body, Buffer.alloc(padded - body.length)]);
}

function buildIndex(
  version: 2 | 3 | 4,
  paths: readonly string[],
  extensions: readonly [string, Buffer][] = [],
  hashLen: 20 | 32 = 20,
): Buffer {
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "ascii");
  header.writeUInt32BE(version, 4);
  header.writeUInt32BE(paths.length, 8);

  const chunks: Buffer[] = [header];
  let previous = Buffer.alloc(0);
  for (const p of paths) {
    const buf = Buffer.from(p, "utf8");
    chunks.push(buildEntry(buf, version, hashLen, previous));
    previous = buf;
  }
  for (const [sig, body] of extensions) {
    const extHeader = Buffer.alloc(8);
    extHeader.write(sig, 0, 4, "ascii");
    extHeader.writeUInt32BE(body.length, 4);
    chunks.push(extHeader, body);
  }
  const payload = Buffer.concat(chunks);
  const digest = createHash(hashLen === 20 ? "sha1" : "sha256")
    .update(payload)
    .digest();
  return Buffer.concat([payload, digest]);
}

function buildEwahRlw(
  bitSize: number,
  runningBit: boolean,
  runningWords: number,
  literals: readonly bigint[] = [],
): Buffer {
  const wordCount = 1 + literals.length;
  const buf = Buffer.alloc(8 + wordCount * 8 + 4);
  buf.writeUInt32BE(bitSize, 0);
  buf.writeUInt32BE(wordCount, 4);
  const rlw =
    (runningBit ? 1n : 0n) |
    ((BigInt(runningWords) & 0xffffffffn) << 1n) |
    (BigInt(literals.length) << 33n);
  buf.writeBigUInt64BE(rlw, 8);
  for (let i = 0; i < literals.length; i++) {
    buf.writeBigUInt64BE(literals[i]!, 16 + i * 8);
  }
  buf.writeUInt32BE(0, 8 + wordCount * 8);
  return buf;
}

describe("git index parser hardening and bounds", () => {
  test("verifies trailing SHA-1 and SHA-256 checksums and rejects corrupted indexes", () => {
    for (const hashLen of [20, 32] as const) {
      const valid = buildIndex(2, ["src/a.ts", "src/b.ts"], [], hashLen);
      expect(parseGitIndex(valid, hashLen).ok).toBe(true);

      const flippedBody = Buffer.from(valid);
      flippedBody[15] = (flippedBody[15] ?? 0) ^ 0x01;
      expect(parseGitIndex(flippedBody, hashLen).ok).toBe(false);

      const flippedTrailer = Buffer.from(valid);
      const last = flippedTrailer.length - 1;
      flippedTrailer[last] = (flippedTrailer[last] ?? 0) ^ 0x80;
      expect(parseGitIndex(flippedTrailer, hashLen).ok).toBe(false);
    }
  });

  test("rejects v4 path compression bomb within bounded memory", () => {
    // 1 initial 60 KiB path + 1,500 3-byte delta entries would expand to ~90 MiB
    // from a ~160 KiB input without an aggregate decoded path-byte cap.
    const prefix = "a/".repeat(30_000);
    const paths: string[] = [`${prefix}0000`];
    for (let i = 1; i <= 1500; i++) {
      paths.push(`${prefix}${String(i).padStart(4, "0")}`);
    }
    const bomb = buildIndex(4, paths, [], 20);
    expect(bomb.length).toBeLessThan(300 * 1024);

    const beforeHeap = process.memoryUsage().heapUsed;
    const result = parseGitIndex(bomb, 20, { maxTotalPathBytes: 4 * 1024 * 1024 });
    const afterHeap = process.memoryUsage().heapUsed;
    expect(result.ok).toBe(false);
    expect(afterHeap - beforeHeap).toBeLessThan(32 * 1024 * 1024);
  });

  test("rejects EWAH compression bombs in split-index link extensions in bounded memory and time", () => {
    const baseOid = Buffer.alloc(20, 0x22);
    const emptyEwah = Buffer.alloc(12); // bitSize=0, wordCount=0, rlwPos=0

    // Bomb 1: 1-bit run claiming 500,000 set bits from an 8-byte RLW.
    const onesBomb = Buffer.concat([baseOid, buildEwahRlw(500_000, true, 100_000), emptyEwah]);
    const idxOnes = buildIndex(2, ["a"], [["link", onesBomb]], 20);

    // Bomb 2: 0-bit run with huge runningWords overflowing bitSize.
    const zerosBomb = Buffer.concat([baseOid, buildEwahRlw(100, false, 0x0fffffff), emptyEwah]);
    const idxZeros = buildIndex(2, ["a"], [["link", zerosBomb]], 20);

    const start = performance.now();
    const beforeHeap = process.memoryUsage().heapUsed;
    expect(parseGitIndex(idxOnes, 20, { allowSplitIndex: true }).ok).toBe(false);
    expect(parseGitIndex(idxZeros, 20, { allowSplitIndex: true }).ok).toBe(false);
    const afterHeap = process.memoryUsage().heapUsed;
    expect(performance.now() - start).toBeLessThan(500);
    expect(afterHeap - beforeHeap).toBeLessThan(16 * 1024 * 1024);
  });

  test("rejects unknown uppercase and lowercase extensions identically", () => {
    for (const sig of ["XXXX", "MAND", "xxxx", "sdir"]) {
      const idx = buildIndex(2, ["a.txt"], [[sig, Buffer.from("payload")]], 20);
      expect(parseGitIndex(idx, 20).ok).toBe(false);
    }
    for (const allowed of ["TREE", "REUC", "EOIE", "IEOT", "UNTR", "FSMN"]) {
      const idx = buildIndex(2, ["a.txt"], [[allowed, Buffer.from("payload")]], 20);
      expect(parseGitIndex(idx, 20).ok).toBe(true);
    }
  });

  test("rejects split-index trailer mismatch, out-of-range/overlapping bitmaps, and bad overlay order", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sweep-split-validate-"));
    try {
      const gitDir = join(tmp, ".git");
      mkdirSync(gitDir, { recursive: true });
      const baseIndex = buildIndex(2, ["a.txt", "b.txt"], [], 20);
      const baseTrailer = baseIndex.subarray(baseIndex.length - 20);
      const wrongOid = Buffer.alloc(20, 0x99);
      const emptyEwah = Buffer.alloc(12);

      // 1. Shared index file exists under wrongOid name, but its trailer != wrongOid.
      writeFileSync(join(gitDir, `sharedindex.${wrongOid.toString("hex")}`), baseIndex);
      const mismatchLink = Buffer.concat([wrongOid, emptyEwah, emptyEwah]);
      writeFileSync(join(gitDir, "index"), buildIndex(2, ["c.txt"], [["link", mismatchLink]], 20));
      expect(readTrackedPathsFromIndex(tmp)).toBeNull();

      // Write shared index under its matching trailer OID for remaining checks.
      writeFileSync(join(gitDir, `sharedindex.${baseTrailer.toString("hex")}`), baseIndex);

      // 2. Delete bit >= baseCount (bit 2 when baseCount is 2).
      const outOfRange = Buffer.concat([
        baseTrailer,
        buildEwahRlw(3, false, 0, [0b100n]),
        emptyEwah,
      ]);
      writeFileSync(join(gitDir, "index"), buildIndex(2, ["c.txt"], [["link", outOfRange]], 20));
      expect(readTrackedPathsFromIndex(tmp)).toBeNull();

      // 3. Overlapping delete and replace bit (bit 0 set in both).
      const overlap = Buffer.concat([
        baseTrailer,
        buildEwahRlw(2, false, 0, [0b01n]),
        buildEwahRlw(2, false, 0, [0b01n]),
      ]);
      writeFileSync(join(gitDir, "index"), buildIndex(2, [""], [["link", overlap]], 20));
      expect(readTrackedPathsFromIndex(tmp)).toBeNull();

      // 4. Overlay order mismatch: replaceCount=1, but first overlay entry has non-empty name.
      const badOverlay = Buffer.concat([
        baseTrailer,
        emptyEwah,
        buildEwahRlw(2, false, 0, [0b01n]),
      ]);
      writeFileSync(
        join(gitDir, "index"),
        buildIndex(2, ["not-empty"], [["link", badOverlay]], 20),
      );
      expect(readTrackedPathsFromIndex(tmp)).toBeNull();

      // 5. Valid split index (delete bit 0, replace bit 1, overlay = ["", "c.txt"]).
      const validLink = Buffer.concat([
        baseTrailer,
        buildEwahRlw(2, false, 0, [0b01n]),
        buildEwahRlw(2, false, 0, [0b10n]),
      ]);
      writeFileSync(join(gitDir, "index"), buildIndex(2, ["", "c.txt"], [["link", validLink]], 20));
      expect(readTrackedPathsFromIndex(tmp)).toEqual(["b.txt", "c.txt"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "rejects symlinked and FIFO index or sharedindex files without blocking",
    () => {
      const tmp = mkdtempSync(join(tmpdir(), "sweep-index-nofollow-"));
      try {
        const gitDir = join(tmp, ".git");
        mkdirSync(gitDir, { recursive: true });
        const realIndex = join(tmp, "real-index");
        writeFileSync(realIndex, buildIndex(2, ["a.txt"], [], 20));

        // Symlinked index
        symlinkSync(realIndex, join(gitDir, "index"));
        expect(readTrackedPathsFromIndex(tmp)).toBeNull();
        rmSync(join(gitDir, "index"));

        // FIFO index (must not block!)
        const mkfifo = spawnSync("mkfifo", [join(gitDir, "index")], { stdio: "ignore" });
        if (mkfifo.status === 0) {
          const t0 = performance.now();
          expect(readTrackedPathsFromIndex(tmp)).toBeNull();
          expect(performance.now() - t0).toBeLessThan(500);
          rmSync(join(gitDir, "index"));
        }

        // Symlinked and FIFO sharedindex.<oid>
        const sharedOid = Buffer.alloc(20, 0x44);
        const sharedPath = join(gitDir, `sharedindex.${sharedOid.toString("hex")}`);
        const splitIdx = buildIndex(
          2,
          ["x.txt"],
          [["link", Buffer.concat([sharedOid, Buffer.alloc(12), Buffer.alloc(12)])]],
          20,
        );
        writeFileSync(join(gitDir, "index"), splitIdx);
        symlinkSync(realIndex, sharedPath);
        expect(readTrackedPathsFromIndex(tmp)).toBeNull();
        rmSync(sharedPath);

        const mkfifoShared = spawnSync("mkfifo", [sharedPath], { stdio: "ignore" });
        if (mkfifoShared.status === 0) {
          const t0 = performance.now();
          expect(readTrackedPathsFromIndex(tmp)).toBeNull();
          expect(performance.now() - t0).toBeLessThan(500);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  test("seeded fuzz corpus never throws and keeps memory bounded", () => {
    let seed = 0x5eed1234;
    const nextU32 = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };

    const baseline = buildIndex(4, ["a/b/c.ts", "a/b/d.ts", "z.txt"], [["TREE", Buffer.from("x")]]);
    const startHeap = process.memoryUsage().heapUsed;
    const startMs = performance.now();

    for (let iter = 0; iter < 2000; iter++) {
      let sample: Buffer;
      const kind = iter % 4;
      if (kind === 0) {
        // Mutated copy of valid v4 index with recomputed checksum so parser runs deep.
        sample = Buffer.from(baseline);
        const mutations = 1 + (nextU32() % 6);
        for (let m = 0; m < mutations; m++) {
          const pos = nextU32() % Math.max(1, sample.length - 20);
          sample[pos] = nextU32() & 0xff;
        }
        const body = sample.subarray(0, sample.length - 20);
        createHash("sha1")
          .update(body)
          .digest()
          .copy(sample, sample.length - 20);
      } else if (kind === 1) {
        // Random DIRC header with arbitrary version/count/payload + valid SHA-1 trailer.
        const len = 12 + (nextU32() % 256);
        const body = Buffer.alloc(len);
        body.write("DIRC", 0, "ascii");
        body.writeUInt32BE(2 + (nextU32() % 4), 4);
        body.writeUInt32BE(nextU32() % 10_000, 8);
        for (let i = 12; i < len; i++) body[i] = nextU32() & 0xff;
        const digest = createHash("sha1").update(body).digest();
        sample = Buffer.concat([body, digest]);
      } else if (kind === 2) {
        // Random bytes.
        const len = nextU32() % 512;
        sample = Buffer.alloc(len);
        for (let i = 0; i < len; i++) sample[i] = nextU32() & 0xff;
      } else {
        // Split-index extension with fuzzed EWAH payload + valid SHA-1 trailer.
        const linkLen = nextU32() % 96;
        const linkBody = Buffer.alloc(linkLen);
        for (let i = 0; i < linkLen; i++) linkBody[i] = nextU32() & 0xff;
        sample = buildIndex(2, ["x"], [["link", linkBody]], 20);
      }
      parseGitIndex(sample, 20, { allowSplitIndex: true, maxTotalPathBytes: 2 * 1024 * 1024 });
      parseGitIndex(sample, 32, { allowSplitIndex: true, maxTotalPathBytes: 2 * 1024 * 1024 });
    }

    const elapsedMs = performance.now() - startMs;
    const heapDelta = process.memoryUsage().heapUsed - startHeap;
    expect(elapsedMs).toBeLessThan(5_000);
    expect(heapDelta).toBeLessThan(64 * 1024 * 1024);
  });
});
