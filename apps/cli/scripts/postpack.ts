/**
 * Restore the workspace manifest that `prepack.ts` rewrote for publication.
 *
 * Runs after `npm pack` / `npm publish`. If a pack is interrupted before this
 * runs, the backup is still on disk and re-running restores it.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(CLI_ROOT, "package.json");
const BACKUP = join(CLI_ROOT, "package.json.prepack-backup");

if (existsSync(BACKUP)) {
  writeFileSync(MANIFEST, readFileSync(BACKUP, "utf8"));
  rmSync(BACKUP);
  console.log("postpack: restored the workspace manifest");
} else {
  console.log("postpack: nothing to restore");
}
