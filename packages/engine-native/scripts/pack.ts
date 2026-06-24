#!/usr/bin/env bun
/**
 * Pack a release `sweep-engine` binary into a platform npm package under `native-packages/`.
 *
 * Usage:
 *   bun run packages/engine-native/scripts/pack.ts --platform linux-64 --binary path/to/sweep-engine
 *   bun run packages/engine-native/scripts/pack.ts --platform linux-64  # uses target/release
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
import { nativePlatformById, NATIVE_PLATFORMS } from "@kitsunekode/sweep-core/native-platforms";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const NATIVE_PACKAGES = join(REPO_ROOT, "native-packages");

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
      console.log(`Usage: pack.ts --platform <id> [--binary <path>] [--version <semver>]`);
      console.log(`Platforms: ${NATIVE_PLATFORMS.map((p) => p.id).join(", ")}`);
      process.exit(0);
    }
  }

  if (!platform) {
    console.error("error: --platform is required");
    process.exit(1);
  }

  const result: { platform: string; binary?: string; version?: string } = { platform };
  if (binary !== undefined) {
    result.binary = binary;
  }
  if (version !== undefined) {
    result.version = version;
  }
  return result;
}

function rootVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "apps/cli/package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

function defaultBinaryPath(platform: ReturnType<typeof nativePlatformById>): string {
  if (!platform) {
    throw new Error("unknown platform");
  }
  const ext = platform.os === "win32" ? ".exe" : "";
  const release = join(REPO_ROOT, "target", "release", `sweep-engine${ext}`);
  if (existsSync(release)) {
    return release;
  }
  const cross = join(REPO_ROOT, "target", platform.cargoTarget, "release", `sweep-engine${ext}`);
  if (existsSync(cross)) {
    return cross;
  }
  const debug = join(REPO_ROOT, "target", "debug", `sweep-engine${ext}`);
  if (existsSync(debug)) {
    return debug;
  }
  throw new Error(
    `no binary found for ${platform.id}; run cargo build --release -p sweep-engine-cli or pass --binary`,
  );
}

const {
  platform: platformId,
  binary: binaryArg,
  version: versionArg,
} = parseArgs(process.argv.slice(2));
const platform = nativePlatformById(platformId);
if (!platform) {
  console.error(`error: unknown platform "${platformId}"`);
  process.exit(1);
}

const version = versionArg ?? rootVersion();
const sourceBinary = resolve(binaryArg ?? defaultBinaryPath(platform));
if (!existsSync(sourceBinary)) {
  console.error(`error: binary not found: ${sourceBinary}`);
  process.exit(1);
}

const outDir = join(NATIVE_PACKAGES, platform.id);
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
  description: `Native sweep-engine binary for ${platform.os} ${platform.cpu}`,
  os: [platform.os],
  cpu: [platform.cpu],
  files: ["bin"],
  license: "MIT",
  repository: {
    type: "git",
    url: "git+https://github.com/KitsuneKode/sweep.git",
  },
  publishConfig: {
    access: "public",
  },
};

writeFileSync(join(outDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`packed ${platform.npmName}@${version} → ${outDir}`);
