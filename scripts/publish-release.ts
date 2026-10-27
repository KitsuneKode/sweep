#!/usr/bin/env bun
/**
 * Release publish orchestration for changesets/action `publish` command.
 *
 * 1. Run prepublishOnly (check, build, preflight)
 * 2. Publish native `@kitsunekode/sweep-engine-*` packages (when packed under native-packages/)
 * 3. Pack @kitsunekode/sweep and publish that tarball, then tag the release
 *
 * The CLI is published from a packed tarball, not with `changeset publish`.
 * `npm publish <dir>` reads package.json before the prepack step rewrites it
 * and sends that original copy as the registry's install metadata, so 0.3.0
 * and 0.5.0 shipped a correct tarball under metadata full of `workspace:` and
 * `catalog:` ranges, and every install failed. A tarball's metadata is the
 * package.json inside it: what is checked is what installs.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_PLATFORMS } from "@kitsunekode/sweep-core/native-platforms";

import { releasePolicy, type PreState } from "../apps/cli/scripts/release-policy.js";
import { requirePublicationCi } from "../apps/cli/scripts/release-ci.js";
import { assertNativeBinary } from "../packages/engine-native/scripts/binary-format.js";
import { assertPublishable } from "../apps/cli/scripts/prepack.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
const requiresNative =
  process.env.CI === "true" || process.env.SWEEP_RELEASE_REQUIRES_NATIVE === "true";
const version = cliVersion();
const preFile = join(REPO_ROOT, ".changeset/pre.json");
const preState = existsSync(preFile)
  ? (JSON.parse(readFileSync(preFile, "utf8")) as PreState)
  : undefined;
const policy = releasePolicy(version, preState);
if (skipNative && requiresNative)
  throw new Error(
    "CI publication requires the complete native matrix; --skip-native is not allowed",
  );

await requirePublicationCi(REPO_ROOT);

// Gate before any publish: a failing check must not strand engine packages on
// the registry with no matching CLI release.
console.log("\nrunning prepublishOnly...");
run("bun", ["run", "prepublishOnly"]);

if (!skipNative) {
  const packed: string[] = [];
  const missing: string[] = [];

  for (const platform of NATIVE_PLATFORMS) {
    const dir = join(REPO_ROOT, "native-packages", platform.id);
    const binPath = join(dir, "bin", platform.binaryName);
    if (existsSync(binPath)) {
      assertNativeBinary(binPath, platform);
      // Actions artifacts drop file modes: 0.5.0's engines were published
      // 0644, failed to spawn with EACCES, and every install quietly fell
      // back to the JS engine. npm keeps the mode that is packed.
      if (platform.os !== "win32") {
        chmodSync(binPath, 0o755);
        if ((statSync(binPath).mode & 0o111) === 0)
          throw new Error(`${binPath} is not executable; refusing to publish it`);
      }
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (manifest.name !== platform.npmName || manifest.version !== version)
        throw new Error(
          `Native package ${platform.id} does not match ${platform.npmName}@${version}`,
        );
      packed.push(platform.id);
    } else {
      missing.push(platform.id);
    }
  }

  if (packed.length === 0) {
    if (requiresNative) {
      console.error(
        "error: no packed native engine binaries found; CI release expects native-packages/*/bin",
      );
      process.exit(1);
    }
    console.warn("warn: skipping native engine publish (no packed binaries)");
  } else {
    if (missing.length > 0) {
      console.warn(`warn: missing packed binaries for: ${missing.join(", ")}`);
      if (requiresNative) {
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
      run("npm", [
        "publish",
        dir,
        "--access",
        "public",
        "--ignore-scripts",
        "--tag",
        policy.distTag,
      ]);
    }
  }
} else {
  console.log("skipping native engine publish (--skip-native)");
}

const CLI_NAME = "@kitsunekode/sweep";
if (alreadyPublished(CLI_NAME, version)) {
  console.log(`\nskipping ${CLI_NAME}@${version} (already published)`);
} else {
  console.log(`\npublishing ${CLI_NAME}@${version}...`);
  const packDir = mkdtempSync(join(tmpdir(), "sweep-pack-"));
  try {
    // `npm pack` runs prepack (resolve workspace:/catalog:) and postpack.
    run("npm", ["pack", join(REPO_ROOT, "apps/cli"), "--pack-destination", packDir]);
    const tarball = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
    if (!tarball) throw new Error("npm pack produced no tarball");
    const tarballPath = join(packDir, tarball);
    run("tar", ["-xzf", tarballPath, "-C", packDir, "package/package.json"]);
    const manifest = JSON.parse(
      readFileSync(join(packDir, "package", "package.json"), "utf8"),
    ) as Record<string, unknown>;
    if (manifest.name !== CLI_NAME || manifest.version !== version)
      throw new Error(`Packed manifest is not ${CLI_NAME}@${version}`);
    // The registry's install metadata is exactly this manifest.
    assertPublishable(manifest);
    run("npm", ["publish", tarballPath, "--access", "public", "--tag", policy.distTag]);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

// The release workflow builds binaries for a new `package@version` tag, and
// changesets/action pushes tags it sees announced in this output.
const tagExists =
  spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${policy.gitTag}`], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  }).status === 0;
if (!tagExists) {
  run("git", ["tag", policy.gitTag]);
  console.log(`🦋  New tag:  ${policy.gitTag}`);
}

const distFiles = existsSync(CLI_DIST_DIR) ? readdirSync(CLI_DIST_DIR) : [];
console.log(`\nrelease complete (apps/cli/dist: ${distFiles.join(", ") || "empty"})`);
