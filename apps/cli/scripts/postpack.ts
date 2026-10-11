/**
 * Restore the workspace manifest that `prepack.ts` rewrote for publication.
 *
 * Runs after `npm pack` / `npm publish`. If a pack is interrupted before this
 * runs, the backup is still on disk and re-running restores it.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./atomic-write.js";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(CLI_ROOT, "package.json");
const BACKUP = join(CLI_ROOT, "package.json.prepack-backup");

if (existsSync(BACKUP)) {
  const original = readFileSync(BACKUP, "utf8");
  try {
    const parsed = JSON.parse(original) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.name !== "string")
      throw new Error("invalid manifest");
  } catch {
    throw new Error(
      "The prepack backup is incomplete or invalid. Leave both files in place and inspect package.json before restoring from version control.",
    );
  }
  atomicWrite(MANIFEST, original);
  rmSync(BACKUP);
  console.log("postpack: restored the workspace manifest");
} else {
  console.log("postpack: nothing to restore");
}
