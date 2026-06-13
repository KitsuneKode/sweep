#!/usr/bin/env bun
/**
 * Sync root optionalDependencies and native-packages template versions to root package.json version.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_PLATFORMS } from "@kitsunekode/sweep-core/native-platforms";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PKG_PATH = join(REPO_ROOT, "package.json");

const rootPkg = JSON.parse(readFileSync(ROOT_PKG_PATH, "utf8")) as {
  version: string;
  optionalDependencies?: Record<string, string>;
};

const version = rootPkg.version;
const optionalDependencies: Record<string, string> = {};

for (const platform of NATIVE_PLATFORMS) {
  optionalDependencies[platform.npmName] = version;

  const templatePath = join(REPO_ROOT, "native-packages", platform.id, "package.json");
  const template = JSON.parse(readFileSync(templatePath, "utf8")) as Record<string, unknown>;
  template.version = version;
  writeFileSync(templatePath, `${JSON.stringify(template, null, 2)}\n`);
}

rootPkg.optionalDependencies = optionalDependencies;
writeFileSync(ROOT_PKG_PATH, `${JSON.stringify(rootPkg, null, 2)}\n`);

console.log(`synced engine package versions to ${version}`);
