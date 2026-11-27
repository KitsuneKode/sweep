#!/usr/bin/env bun
/**
 * Sync CLI optionalDependencies and native-packages template versions to apps/cli version.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_PLATFORMS } from "@kitsunekode/sweep-core/native-platforms";
import { nativePackageJson } from "../packages/engine-native/scripts/package-json.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PKG_PATH = join(REPO_ROOT, "apps/cli/package.json");

const cliPkg = JSON.parse(readFileSync(CLI_PKG_PATH, "utf8")) as {
  version: string;
  optionalDependencies?: Record<string, string>;
};

const version = cliPkg.version;
const optionalDependencies: Record<string, string> = { ...cliPkg.optionalDependencies };

const sortedPlatforms = [...NATIVE_PLATFORMS].sort((a, b) => a.npmName.localeCompare(b.npmName));
for (const platform of sortedPlatforms) {
  optionalDependencies[platform.npmName] = version;

  const templatePath = join(REPO_ROOT, "native-packages", platform.id, "package.json");
  writeFileSync(templatePath, nativePackageJson(platform, version));
}

cliPkg.optionalDependencies = optionalDependencies;
writeFileSync(CLI_PKG_PATH, `${JSON.stringify(cliPkg, null, 2)}\n`);

console.log(`synced engine package versions to ${version}`);
