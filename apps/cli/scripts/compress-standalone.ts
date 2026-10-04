import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { createWriteStream } from "node:fs";

async function digest(path: string, unzip = false): Promise<string> {
  const hash = createHash("sha256");
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  });
  if (unzip) await pipeline(createReadStream(path), createGunzip(), sink);
  else await pipeline(createReadStream(path), sink);
  return hash.digest("hex");
}

/** Keep raw release assets; add a checksummed gzip without buffering the binary. */
export async function compressStandalone(input: string): Promise<string> {
  const source = resolve(input);
  const archive = `${source}.gz`;
  const checksum = `${archive}.sha256`;
  const owned = await mkdtemp(join(dirname(source), ".sweep-compress-"));
  const staged = join(owned, "binary.gz");
  let createdArchive = false;
  let createdChecksum = false;
  try {
    const original = await digest(source);
    await pipeline(createReadStream(source), createGzip({ level: 9 }), createWriteStream(staged));
    if ((await digest(staged, true)) !== original || (await digest(source)) !== original) {
      throw new Error("standalone compression: source changed or round-trip checksum differs");
    }
    await copyFile(staged, archive, constants.COPYFILE_EXCL);
    createdArchive = true;
    await writeFile(checksum, `${await digest(archive)}  ${basename(archive)}\n`, { flag: "wx" });
    createdChecksum = true;
    return archive;
  } catch (error) {
    if (createdChecksum) await rm(checksum, { force: true });
    if (createdArchive) await rm(archive, { force: true });
    throw error;
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const input = process.argv[2];
  if (!input) throw new Error("usage: compress-standalone.ts <binary>");
  console.log(`compressed and round-trip verified: ${await compressStandalone(input)}`);
}
