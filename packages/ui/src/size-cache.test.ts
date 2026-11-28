import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { cachedBytes, loadSizeCache, saveSizeCache } from "./size-cache.js";

const roots: string[] = [];
const directory = () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-size-cache-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const candidate = {
  path: "/project/node_modules",
  identity: { platform: "unix", device: "1", inode: "2" },
  estimatedBytes: 4096,
  bytesKnown: true,
} as unknown as ScanCandidate;

test("measured sizes round-trip for the same folder identity", () => {
  const root = directory();
  saveSizeCache([candidate], root);
  expect(cachedBytes(loadSizeCache(root), candidate)).toBe(4096);
});

test.skipIf(process.platform === "win32")(
  "a cache directory others can write reads as empty",
  () => {
    const root = directory();
    saveSizeCache([candidate], root);
    chmodSync(root, 0o777);
    try {
      expect(loadSizeCache(root).size).toBe(0);
    } finally {
      chmodSync(root, 0o700);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a FIFO swapped in after the check does not block loading",
  () => {
    const root = directory();
    saveSizeCache([candidate], root);
    const path = join(root, "size-cache.json");
    const realOpen = fs.openSync;
    const spy = spyOn(fs, "openSync").mockImplementation(((
      target: fs.PathLike,
      flags?: fs.OpenMode,
      mode?: fs.Mode,
    ) => {
      if (String(target) === path) {
        unlinkSync(path);
        expect(spawnSync("mkfifo", [path]).status).toBe(0);
      }
      return realOpen(target, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(loadSizeCache(root).size).toBe(0);
    } finally {
      spy.mockRestore();
    }
  },
  5000,
);
