/**
 * Copy root README and LICENSE into the publishable package before npm pack/publish.
 */

import { copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(CLI_ROOT, "../..");

for (const file of ["README.md", "LICENSE"] as const) {
  copyFileSync(join(REPO_ROOT, file), join(CLI_ROOT, file));
}

console.log("prepack: copied README.md and LICENSE into apps/cli");
