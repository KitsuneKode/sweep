import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: run-at-repo-root.ts <command> [args...]");
  process.exit(1);
}

const nodePath = [
  join(REPO_ROOT, "node_modules"),
  join(REPO_ROOT, "packages/integration-tests/node_modules"),
]
  .concat(process.env.NODE_PATH?.split(delimiter).filter(Boolean) ?? [])
  .join(delimiter);

const result = spawnSync(command, args, {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_PATH: nodePath,
  },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
