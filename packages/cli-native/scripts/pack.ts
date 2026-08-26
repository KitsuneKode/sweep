#!/usr/bin/env bun
/**
 * Pack a compiled standalone `sweep` executable into a platform npm package
 * under `native-packages/` — mirrors packages/engine-native/scripts/pack.ts.
 *
 * Usage:
 *   bun run packages/cli-native/scripts/pack.ts --platform darwin-arm64 \
 *     --binary /path/to/sweep [--version 1.2.3]
 *
 * Platforms come from CLI_BINARY_PLATFORMS in @kitsunekode/sweep-core.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_BINARY_PLATFORMS,
  type CliBinaryPlatform,
} from "@kitsunekode/sweep-core/native-platforms";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Platform packages are workspace members under packages/platforms/<id> so
// changesets versions them in lockstep with @kitsunekode/sweep (fixed group).
const PACK_OUT = join(REPO_ROOT, "packages", "platforms");

function parseArgs(argv: string[]): { platform: string; binary?: string; version?: string } {
  let platform = "";
  let binary: string | undefined;
  let version: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--platform" || arg === "-p") {
      platform = argv[++i] ?? "";
    } else if (arg === "--binary" || arg === "-b") {
      binary = argv[++i];
    } else if (arg === "--version" || arg === "-v") {
      version = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: pack.ts --platform <id> --binary <path> [--version <semver>]");
      console.log(`Platforms: ${CLI_BINARY_PLATFORMS.map((p) => p.id).join(", ")}`);
      process.exit(0);
    }
  }

  if (!platform) {
    console.error("error: --platform is required");
    process.exit(1);
  }
  return {
    platform,
    ...(binary !== undefined ? { binary } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

function rootVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "apps/cli/package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

const {
  platform: platformId,
  binary: binaryArg,
  version: versionArg,
} = parseArgs(process.argv.slice(2));

const platform = CLI_BINARY_PLATFORMS.find((p) => p.id === platformId) as
  | CliBinaryPlatform
  | undefined;
if (!platform) {
  console.error(`error: unknown platform "${platformId}"`);
  process.exit(1);
}

const version = versionArg ?? rootVersion();
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`error: invalid semver for platform package: ${version}`);
  process.exit(1);
}

const sourceBinary = binaryArg
  ? resolve(binaryArg)
  : join(REPO_ROOT, "apps/cli", `sweep-${platform.id}${platform.os === "win32" ? ".exe" : ""}`);
if (!existsSync(sourceBinary)) {
  console.error(`error: binary not found: ${sourceBinary} (pass --binary)`);
  process.exit(1);
}

const outDir = join(PACK_OUT, platform.id);
const binDir = join(outDir, "bin");
mkdirSync(binDir, { recursive: true });

const destBinary = join(binDir, platform.binaryName);
copyFileSync(sourceBinary, destBinary);
if (platform.os !== "win32") {
  chmodSync(destBinary, 0o755);
}

const packageJson = {
  name: platform.npmName,
  version,
  description: `Standalone sweep CLI binary for ${platform.os} ${platform.cpu}`,
  os: [platform.os],
  cpu: [platform.cpu],
  publishConfig: { access: "public" },
  files: ["bin"],
};

writeFileSync(join(outDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

console.log(`✓ packed ${platform.npmName}@${version} → ${outDir}`);
