#!/usr/bin/env bun
/**
 * Dev entrypoint: ensure workspace deps exist, then run the CLI from source.
 *
 * Before the monorepo split, commander lived on the root package. Now it is
 * installed per-workspace under apps/cli/node_modules — a plain `bun install`
 * at the repo root is required after clone or branch switches.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_COMMANDER = join(ROOT, "apps/cli/node_modules/commander");

function ensureWorkspaceDeps(): void {
  if (existsSync(CLI_COMMANDER)) {
    return;
  }

  console.error("sweep: workspace dependencies are missing — running bun install…");
  const install = spawnSync("bun", ["install"], { cwd: ROOT, stdio: "inherit" });
  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }

  if (!existsSync(CLI_COMMANDER)) {
    console.error(
      "sweep: apps/cli dependencies still missing after install.\n" +
        "Try: bun install --force\n" +
        "Or use the built CLI: bun run build && node apps/cli/dist/sweep.js",
    );
    process.exit(1);
  }
}

ensureWorkspaceDeps();

const args = process.argv.slice(2);
const result = spawnSync("bun", ["run", "./src/bin.ts", ...args], {
  cwd: join(ROOT, "apps/cli"),
  stdio: "inherit",
});

process.exit(result.status ?? 1);
