#!/usr/bin/env bun
/**
 * Release publish orchestration for changesets/action `publish` command.
 *
 * 1. Publish native `@kitsunekode/sweep-engine-*` packages (when packed under native-packages/)
 * 2. Run prepublishOnly (check, build, preflight)
 * 3. Run changeset publish for @kitsunekode/sweep
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_PLATFORMS } from "@kitsunekode/sweep-core/native-platforms";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PKG_PATH = join(REPO_ROOT, "apps/cli/package.json");
const CLI_DIST_DIR = join(REPO_ROOT, "apps/cli/dist");

function run(command: string, args: string[], options: { cwd?: string } = {}): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function cliVersion(): string {
  return execFileSync("node", ["-p", "require('./package.json').version"], {
    cwd: join(REPO_ROOT, "apps/cli"),
    encoding: "utf8",
  }).trim();
}

const skipNative = process.argv.includes("--skip-native");
const requiresNative = process.env.SWEEP_RELEASE_REQUIRES_NATIVE === "true";
const version = cliVersion();

if (!skipNative) {
  const packed: string[] = [];
  const missing: string[] = [];

  for (const platform of NATIVE_PLATFORMS) {
    const dir = join(REPO_ROOT, "native-packages", platform.id);
    const binPath = join(dir, "bin", platform.binaryName);
    if (existsSync(binPath)) {
      packed.push(platform.id);
    } else {
      missing.push(platform.id);
    }
  }

  if (packed.length === 0) {
    if (process.env.CI === "true" && requiresNative) {
      console.error(
        "error: no packed native engine binaries found; CI release expects native-packages/*/bin",
      );
      process.exit(1);
    }
    console.warn("warn: skipping native engine publish (no packed binaries)");
  } else {
    if (missing.length > 0) {
      console.warn(`warn: missing packed binaries for: ${missing.join(", ")}`);
      if (process.env.CI === "true" && requiresNative) {
        console.error("error: incomplete native engine matrix in CI");
        process.exit(1);
      }
    }

    for (const platform of NATIVE_PLATFORMS) {
      const dir = join(REPO_ROOT, "native-packages", platform.id);
      const binPath = join(dir, "bin", platform.binaryName);
      if (!existsSync(binPath)) {
        continue;
      }
      console.log(`\npublishing ${platform.npmName}@${version}...`);
      const publishArgs = ["publish", dir, "--access", "public", "--ignore-scripts"];
      if (process.env.CI === "true") {
        publishArgs.push("--provenance");
      }
      run("npm", publishArgs);
    }
  }
} else {
  console.log("skipping native engine publish (--skip-native)");
}

console.log("\nrunning prepublishOnly...");
run("bun", ["run", "prepublishOnly"]);

console.log("\npublishing @kitsunekode/sweep...");
const changesetArgs = ["changeset", "publish"];
if (process.env.CI === "true") {
  changesetArgs.push("--provenance");
}
run("bunx", changesetArgs);

const distFiles = existsSync(CLI_DIST_DIR) ? readdirSync(CLI_DIST_DIR) : [];
console.log(`\nrelease complete (apps/cli/dist: ${distFiles.join(", ") || "empty"})`);
