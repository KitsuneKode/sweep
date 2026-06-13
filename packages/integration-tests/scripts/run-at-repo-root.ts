import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: run-at-repo-root.ts <command> [args...]");
  process.exit(1);
}

const result = spawnSync(command, args, {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
