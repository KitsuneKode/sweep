import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { compressStandalone } from "./compress-standalone";

test("release gzip preserves executable bytes, checksums, and existing archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "sweep-compress-test-"));
  try {
    const source = join(root, "sweep-test");
    const bytes = Buffer.alloc(1024 * 1024, 0xab);
    await writeFile(source, bytes);
    const archive = await compressStandalone(source);
    const compressed = await readFile(archive);
    expect(gunzipSync(compressed)).toEqual(bytes);
    const checksum = createHash("sha256").update(compressed).digest("hex");
    expect(await readFile(`${archive}.sha256`, "utf8")).toBe(`${checksum}  sweep-test.gz\n`);
    await expect(compressStandalone(source)).rejects.toThrow();
    expect(await readFile(archive)).toEqual(compressed);
    expect((await readdir(root)).sort()).toEqual([
      "sweep-test",
      "sweep-test.gz",
      "sweep-test.gz.sha256",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
