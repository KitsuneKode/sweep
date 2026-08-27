#!/usr/bin/env bun
/**
 * Publish placeholder releases for native engine packages that do not exist yet.
 *
 * npm only exposes the Trusted Publisher (OIDC) setting on a package that has
 * already been published, so a brand-new platform package cannot be bootstrapped
 * by CI: the first publish has to come from an authenticated human. This script
 * is that step. It publishes a tiny, binary-free placeholder at a version below
 * any real release, after which a trusted publisher can be configured and every
 * subsequent version is published by CI over OIDC.
 *
 * Idempotent: packages that already exist on npm are skipped, so it is safe to
 * re-run when a new platform is added to NATIVE_PLATFORMS.
 *
 *   bun run scripts/bootstrap-native-placeholders.ts            # report only
 *   bun run scripts/bootstrap-native-placeholders.ts --publish  # actually publish
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_PLATFORMS } from "@kitsunekode/sweep-core/native-platforms";

/**
 * Deliberately below any shipping version. The CLI pins its engines to an exact
 * version, so a placeholder must never occupy one a real release will want.
 */
const PLACEHOLDER_VERSION = "0.0.1";

const publish = process.argv.includes("--publish");

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
        repository: { type: "git", url: "git+https://github.com/KitsuneKode/sweep.git" },
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
[@kitsunekode/sweep](https://www.npmjs.com/package/@kitsunekode/sweep). You do not
need to install this directly.
`,
  );
}

const staging = mkdtempSync(join(tmpdir(), "sweep-placeholders-"));
const missing: Array<{ name: string; dir: string }> = [];

for (const platform of NATIVE_PLATFORMS) {
  const existing = publishedVersion(platform.npmName);
  if (existing) {
    console.log(`skip    ${platform.npmName} (already on npm at ${existing})`);
    continue;
  }
  const dir = join(staging, platform.id);
  writePlaceholder(dir, platform.npmName, platform.os, platform.cpu);
  missing.push({ name: platform.npmName, dir });
}

if (missing.length === 0) {
  console.log("\nEvery native package exists on npm; nothing to bootstrap.");
  process.exit(0);
}

if (!publish) {
  console.log(
    `\n${missing.length} package(s) would be published at ${PLACEHOLDER_VERSION}:\n` +
      missing.map((entry) => `  ${entry.name}`).join("\n") +
      "\n\nRe-run with --publish to publish them. Publishing is irreversible and" +
      "\nwill prompt for 2FA.",
  );
  process.exit(0);
}

let failed = 0;
for (const entry of missing) {
  console.log(`\npublishing ${entry.name}@${PLACEHOLDER_VERSION}...`);
  const result = spawnSync("npm", ["publish", entry.dir, "--access", "public"], {
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(`error: failed to publish ${entry.name}`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n${failed} package(s) failed to publish.`);
  process.exit(1);
}

console.log(
  "\nAll placeholders published. Next: configure a trusted publisher for each" +
    "\n(npmjs.com -> package Settings -> Trusted Publisher; GitHub Actions," +
    "\nKitsuneKode/sweep, workflow release.yml), then re-run the Release workflow.",
);
