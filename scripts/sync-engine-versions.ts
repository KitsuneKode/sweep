#!/usr/bin/env bun
/**
 * Sync CLI optionalDependencies and native-packages template versions to apps/cli version.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_PLATFORMS } from "@kitsunekode/sweep-core/native-platforms";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PKG_PATH = join(REPO_ROOT, "apps/cli/package.json");

const cliPkg = JSON.parse(readFileSync(CLI_PKG_PATH, "utf8")) as {
  version: string;
  optionalDependencies?: Record<string, string>;
};

const version = cliPkg.version;
const optionalDependencies: Record<string, string> = {};

for (const platform of NATIVE_PLATFORMS) {
  optionalDependencies[platform.npmName] = version;

  const templatePath = join(REPO_ROOT, "native-packages", platform.id, "package.json");
  const template = JSON.parse(readFileSync(templatePath, "utf8")) as Record<string, unknown>;
  template.version = version;
  writeFileSync(templatePath, `${JSON.stringify(template, null, 2)}\n`);
}

cliPkg.optionalDependencies = optionalDependencies;
writeFileSync(CLI_PKG_PATH, `${JSON.stringify(cliPkg, null, 2)}\n`);

console.log(`synced engine package versions to ${version}`);
