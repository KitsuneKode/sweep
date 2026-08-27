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

/**
 * True when this exact version is already on the registry.
 *
 * Publishing six packages behind an interactive 2FA prompt is easy to
 * interrupt, and npm refuses to republish a version. Without this a retry dies
 * on the first package that already made it, stranding the release half done.
 */
function alreadyPublished(name: string, version: string): boolean {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.trim().length > 0;
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
      if (alreadyPublished(platform.npmName, version)) {
        console.log(`\nskipping ${platform.npmName}@${version} (already published)`);
        continue;
      }
      console.log(`\npublishing ${platform.npmName}@${version}...`);
      // No --provenance: trusted publishing attests automatically, and the
      // flag is only needed for token-authenticated publishes.
      run("npm", ["publish", dir, "--access", "public", "--ignore-scripts"]);
    }
  }
} else {
  console.log("skipping native engine publish (--skip-native)");
}

console.log("\nrunning prepublishOnly...");
run("bun", ["run", "prepublishOnly"]);

console.log("\npublishing @kitsunekode/sweep...");
run("bunx", ["changeset", "publish"]);

const distFiles = existsSync(CLI_DIST_DIR) ? readdirSync(CLI_DIST_DIR) : [];
console.log(`\nrelease complete (apps/cli/dist: ${distFiles.join(", ") || "empty"})`);
