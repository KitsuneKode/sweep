#!/usr/bin/env bun
/**
 * Prepare npm so CI can publish over OIDC (trusted publishing).
 *
 * Two things must be true for every package the release publishes:
 *
 *   1. The package exists on the registry. npm only exposes the trusted
 *      publisher setting on a package that has already been published, so a
 *      brand-new platform package cannot be bootstrapped by CI. The first
 *      publish has to come from an authenticated human.
 *   2. A trusted publisher is registered for it, pointing at this repo and
 *      workflow.
 *
 * This script does both. It is idempotent: packages already on npm are not
 * republished, and `npm trust github` is safe to re-run when a platform is
 * added to NATIVE_PLATFORMS.
 *
 * Every npm write here prompts for 2FA, so it has to be run by a human:
 *
 *   bun run bootstrap:npm-trust                      # report only
 *   bun run bootstrap:npm-trust -- --publish --trust # do it
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_PLATFORMS } from "@kitsunekode/sweep-core/native-platforms";

const CLI_PACKAGE = "@kitsunekode/sweep";
const REPO = "KitsuneKode/sweep";
const WORKFLOW = "release.yml";

/**
 * Deliberately below any shipping version. The CLI pins its engines to an exact
 * version, so a placeholder must never occupy one a real release wants.
 */
const PLACEHOLDER_VERSION = "0.0.1";

const publishMissing = process.argv.includes("--publish");
const configureTrust = process.argv.includes("--trust");

/** Latest published version, or null when the package does not exist. */
function publishedVersion(name: string): string | null {
  try {
    return execFileSync("npm", ["view", name, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function writePlaceholder(dir: string, name: string, os: string, cpu: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: PLACEHOLDER_VERSION,
        description: `Placeholder for the sweep-engine binary for ${os} ${cpu}. Reserves the package so npm trusted publishing can be configured; real builds are published by CI.`,
        license: "MIT",
        repository: { type: "git", url: `git+https://github.com/${REPO}.git` },
        os: [os],
        cpu: [cpu],
        files: ["README.md"],
        publishConfig: { access: "public" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(dir, "README.md"),
    `# ${name}

Placeholder release. This package exists so a trusted publisher (npm OIDC) can be
configured for it - npm only exposes that setting on a package that already exists.

It contains no binary. Real builds are published from CI and resolve automatically
as an optional dependency of
[${CLI_PACKAGE}](https://www.npmjs.com/package/${CLI_PACKAGE}). You do not need to
install this directly.
`,
  );
}

const staging = mkdtempSync(join(tmpdir(), "sweep-placeholders-"));
const missing: Array<{ name: string; dir: string }> = [];
const allPackages = [CLI_PACKAGE, ...NATIVE_PLATFORMS.map((platform) => platform.npmName)];

for (const platform of NATIVE_PLATFORMS) {
  const existing = publishedVersion(platform.npmName);
  if (existing) {
    console.log(`exists   ${platform.npmName} (${existing})`);
    continue;
  }
  console.log(`missing  ${platform.npmName}`);
  const dir = join(staging, platform.id);
  writePlaceholder(dir, platform.npmName, platform.os, platform.cpu);
  missing.push({ name: platform.npmName, dir });
}

const cliVersion = publishedVersion(CLI_PACKAGE);
console.log(
  `${cliVersion ? "exists  " : "MISSING "} ${CLI_PACKAGE}${cliVersion ? ` (${cliVersion})` : ""}`,
);

if (!publishMissing && !configureTrust) {
  console.log(
    `\nDry run. Nothing was changed.\n\n` +
      `  ${missing.length} placeholder(s) to publish\n` +
      `  ${allPackages.length} package(s) to point at ${REPO} / ${WORKFLOW}\n\n` +
      `Re-run with --publish --trust to apply. Both prompt for 2FA, and\n` +
      `publishing is irreversible.`,
  );
  process.exit(0);
}

let failures = 0;

if (publishMissing) {
  for (const entry of missing) {
    console.log(`\npublishing ${entry.name}@${PLACEHOLDER_VERSION}...`);
    const result = spawnSync("npm", ["publish", entry.dir, "--access", "public"], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error(`error: failed to publish ${entry.name}`);
      failures += 1;
    }
  }
}

if (configureTrust) {
  for (const name of allPackages) {
    // A package that never got published cannot carry a trusted publisher yet.
    if (!publishedVersion(name)) {
      console.error(`skip: ${name} is not on npm yet, so it cannot be trusted`);
      failures += 1;
      continue;
    }
    console.log(`\ntrusting ${name} -> ${REPO} (${WORKFLOW})...`);
    const result = spawnSync(
      "npm",
      ["trust", "github", name, "--file", WORKFLOW, "--repo", REPO, "--yes"],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      console.error(`error: failed to configure trusted publishing for ${name}`);
      failures += 1;
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} step(s) failed.`);
  process.exit(1);
}

console.log("\nnpm is ready. Re-run the Release workflow to publish over OIDC.");
