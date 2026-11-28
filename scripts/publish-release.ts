#!/usr/bin/env bun
/**
 * Release publish orchestration for changesets/action `publish` command.
 *
 * 1. Run prepublishOnly (check, build, preflight)
 * 2. Publish native `@kitsunekode/sweep-engine-*` packages (when packed under native-packages/)
 * 3. Pack @kitsunekode/sweep (embedding `gitHead`) and publish that tarball
 * 4. Create a missing scoped tag (`@kitsunekode/sweep@X.Y.Z`) ONLY at the verified
 *    npm `gitHead` commit (never blindly at the current checkout), after proving
 *    it is an ancestor of `origin/main` and matches `apps/cli/package.json`
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
import { NATIVE_PLATFORMS, type NativePlatform } from "@kitsunekode/sweep-core/native-platforms";

import { releasePolicy, type PreState } from "../apps/cli/scripts/release-policy.js";
import { requirePublicationCi } from "../apps/cli/scripts/release-ci.js";
import { assertNativeBinary } from "../packages/engine-native/scripts/binary-format.js";
import { assertPublishable } from "../apps/cli/scripts/prepack.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_DIST_DIR = join(REPO_ROOT, "apps/cli/dist");
const CLI_NAME = "@kitsunekode/sweep";
const SHA_RE = /^[a-f0-9]{40}$/;

export type NpmPackageRecord =
  | { status: "found"; version: string; gitHead: string | null }
  | { status: "not_found" }
  | { status: "error"; error: string };

export interface ScopedTagResolutionInput {
  version: string;
  gitTag: string;
  npmRecord: NpmPackageRecord;
  existingScopedTagSha: string | null;
  npmGitHeadOnMain: boolean;
  npmGitHeadPackageVersion: string | null;
}

export type ScopedTagResolutionResult =
  | { ok: true; action: "create" | "noop"; targetCommit: string }
  | { ok: false; reason: string };

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

function gitOptional(repoRoot: string, args: string[]): string | null {
  const proc = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (proc.status !== 0) return null;
  const out = proc.stdout.trim();
  return out.length > 0 ? out : null;
}

function gitIsAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  const proc = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return proc.status === 0;
}

function npmViewStatus(
  spec: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  status: "found" | "not_found" | "error";
  output: string;
  error?: string;
} {
  const result = spawnSync("npm", ["view", spec, "version"], {
    env,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout?.trim() ?? "";
  const stderr = result.stderr?.trim() ?? "";
  if (result.status === 0 && stdout.length > 0) {
    return { status: "found", output: stdout };
  }
  const combined = `${stdout}\n${stderr}`;
  if (/\bE404\b|404 Not Found|is not in this registry/i.test(combined)) {
    return { status: "not_found", output: stdout };
  }
  return {
    status: "error",
    output: stdout,
    error: combined.trim() || `npm view ${spec} exited with status ${String(result.status)}`,
  };
}

export function readNpmPackageRecord(
  name: string,
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): NpmPackageRecord {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "gitHead", "--json"], {
    env,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout?.trim() ?? "";
  const stderr = result.stderr?.trim() ?? "";
  if (result.status !== 0) {
    const combined = `${stdout}\n${stderr}`;
    if (/\bE404\b|404 Not Found|is not in this registry/i.test(combined)) {
      return { status: "not_found" };
    }
    return {
      status: "error",
      error:
        combined.trim() ||
        `npm view ${name}@${version} exited with status ${String(result.status)}`,
    };
  }
  if (!stdout) {
    return { status: "not_found" };
  }
  try {
    const parsed = JSON.parse(stdout) as string | { version?: string; gitHead?: string };
    if (typeof parsed === "string") {
      return parsed.trim() === version
        ? { status: "found", version, gitHead: null }
        : { status: "not_found" };
    }
    if (parsed.version !== version) {
      return { status: "not_found" };
    }
    const gitHead =
      typeof parsed.gitHead === "string" && SHA_RE.test(parsed.gitHead) ? parsed.gitHead : null;
    return { status: "found", version, gitHead };
  } catch (error) {
    return {
      status: "error",
      error: `Failed to parse npm view JSON for ${name}@${version}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function resolveScopedTagTarget(input: ScopedTagResolutionInput): ScopedTagResolutionResult {
  if (input.npmRecord.status === "error") {
    return {
      ok: false,
      reason: `Failed to query npm for ${CLI_NAME}@${input.version}: ${input.npmRecord.error}`,
    };
  }
  if (input.npmRecord.status === "not_found") {
    return {
      ok: false,
      reason: `Refusing to create ${input.gitTag}: ${CLI_NAME}@${input.version} is not visible on npm`,
    };
  }

  const npmGitHead = input.npmRecord.gitHead;
  if (!npmGitHead) {
    return {
      ok: false,
      reason:
        `Refusing automatic scoped tag creation/qualification for ${input.gitTag}: published ${CLI_NAME}@${input.version} on npm has no gitHead metadata (legacy release). ` +
        `Manual path: verify the published npm tarball commit, then run \`git tag ${input.gitTag} <verified-sha> && git push origin ${input.gitTag}\`.`,
    };
  }

  if (!SHA_RE.test(npmGitHead)) {
    return {
      ok: false,
      reason: `Published ${CLI_NAME}@${input.version} on npm has invalid gitHead ${JSON.stringify(npmGitHead)}`,
    };
  }

  if (!input.npmGitHeadOnMain) {
    return {
      ok: false,
      reason: `Published npm gitHead ${npmGitHead} for ${CLI_NAME}@${input.version} is not an ancestor of canonical main`,
    };
  }

  if (input.npmGitHeadPackageVersion !== input.version) {
    return {
      ok: false,
      reason: `apps/cli/package.json at published npm gitHead ${npmGitHead} has version ${JSON.stringify(input.npmGitHeadPackageVersion)}, expected ${input.version}`,
    };
  }

  if (input.existingScopedTagSha !== null) {
    if (input.existingScopedTagSha !== npmGitHead) {
      return {
        ok: false,
        reason: `Existing scoped tag ${input.gitTag} (${input.existingScopedTagSha}) disagrees with published npm gitHead (${npmGitHead})`,
      };
    }
    return { ok: true, action: "noop", targetCommit: npmGitHead };
  }

  return { ok: true, action: "create", targetCommit: npmGitHead };
}

export function ensureScopedTagAtPublishedCommit(options: {
  repoRoot: string;
  version: string;
  gitTag: string;
  mainRef?: string;
  env?: NodeJS.ProcessEnv;
  readNpm?: (name: string, version: string) => NpmPackageRecord;
}): { action: "create" | "noop"; targetCommit: string } {
  const { repoRoot, version, gitTag } = options;
  const mainRef = options.mainRef ?? "origin/main";
  const env = options.env ?? process.env;

  const mainRefSha = gitOptional(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${mainRef}^{commit}`,
  ]);
  if (!mainRefSha) {
    throw new Error(
      `Refusing to create or verify ${gitTag}: canonical main ref ${mainRef} does not resolve to a commit`,
    );
  }

  const npmRecord = options.readNpm
    ? options.readNpm(CLI_NAME, version)
    : readNpmPackageRecord(CLI_NAME, version, env);

  const existingScopedTagSha = gitOptional(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/tags/${gitTag}^{commit}`,
  ]);

  const npmGitHead = npmRecord.status === "found" ? npmRecord.gitHead : null;
  const npmGitHeadExists =
    npmGitHead !== null &&
    gitOptional(repoRoot, ["rev-parse", "--verify", "--quiet", `${npmGitHead}^{commit}`]) ===
      npmGitHead;
  const npmGitHeadOnMain = npmGitHeadExists && gitIsAncestor(repoRoot, npmGitHead, mainRefSha);

  let npmGitHeadPackageVersion: string | null = null;
  if (npmGitHeadExists) {
    const rawPkg = gitOptional(repoRoot, ["show", `${npmGitHead}:apps/cli/package.json`]);
    if (rawPkg) {
      try {
        const parsed = JSON.parse(rawPkg) as { version?: unknown };
        npmGitHeadPackageVersion = typeof parsed.version === "string" ? parsed.version : null;
      } catch {
        npmGitHeadPackageVersion = null;
      }
    }
  }

  const resolution = resolveScopedTagTarget({
    version,
    gitTag,
    npmRecord,
    existingScopedTagSha,
    npmGitHeadOnMain,
    npmGitHeadPackageVersion,
  });

  if (!resolution.ok) {
    throw new Error(resolution.reason);
  }

  if (resolution.action === "create") {
    const tagProc = spawnSync("git", ["tag", gitTag, resolution.targetCommit], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (tagProc.status !== 0) {
      throw new Error(
        `git tag ${gitTag} ${resolution.targetCommit} failed (${String(tagProc.status)}): ${tagProc.stderr.trim()}`,
      );
    }
  }

  return { action: resolution.action, targetCommit: resolution.targetCommit };
}

/**
 * True when this exact version is already on the registry.
 *
 * Publishing seven packages behind an interactive 2FA prompt is easy to
 * interrupt, and npm refuses to republish a version. Without this a retry dies
 * on the first package that already made it, stranding the release half done.
 */
function alreadyPublished(name: string, version: string): boolean {
  const probe = npmViewStatus(`${name}@${version}`);
  if (probe.status === "error") {
    throw new Error(`Failed to query npm registry for ${name}@${version}: ${probe.error}`);
  }
  return probe.status === "found";
}

/**
 * Verify every target native package already exists on npm (at any version)
 * before publishing the first one, so an unregistered package name cannot
 * strand earlier engine packages on the registry.
 */
function assertNativePackagesRegistered(names: readonly string[]): void {
  const unregistered: string[] = [];
  for (const name of names) {
    const probe = npmViewStatus(name);
    if (probe.status === "error") {
      throw new Error(`Failed to verify npm registration for ${name}: ${probe.error}`);
    }
    if (probe.status === "not_found") {
      unregistered.push(name);
    }
  }
  if (unregistered.length > 0) {
    throw new Error(
      `Unregistered native engine package(s) on npm: ${unregistered.join(", ")}. ` +
        `Run \`bun run bootstrap:npm-trust -- --publish --trust\` before merging the release PR.`,
    );
  }
}

/**
 * Confirm all required native engine packages are queryable at the exact
 * release version on npm before promoting `@kitsunekode/sweep`.
 */
async function waitForNativePackagesPublished(
  names: readonly string[],
  version: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let missing = [...names];
  while (true) {
    const stillMissing: string[] = [];
    for (const name of missing) {
      if (!alreadyPublished(name, version)) {
        stillMissing.push(name);
      }
    }
    if (stillMissing.length === 0) {
      return;
    }
    missing = stillMissing;
    if (Date.now() >= deadline) {
      throw new Error(
        `Refusing to publish @kitsunekode/sweep@${version}: native engine package(s) not available at ${version}: ${missing.join(", ")}`,
      );
    }
    console.log(`waiting for npm registry propagation at ${version}: ${missing.join(", ")}...`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5_000));
  }
}

/**
 * Confirm `@kitsunekode/sweep@version` is queryable on npm with the expected
 * `gitHead` after a fresh publish before tagging.
 */
async function waitForCliPublishedWithGitHead(
  version: string,
  expectedGitHead: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const record = readNpmPackageRecord(CLI_NAME, version);
    if (record.status === "error") {
      throw new Error(`Failed to verify ${CLI_NAME}@${version} on npm: ${record.error}`);
    }
    if (record.status === "found") {
      if (record.gitHead !== expectedGitHead) {
        throw new Error(
          `Published ${CLI_NAME}@${version} on npm reports gitHead ${JSON.stringify(record.gitHead)}, expected ${expectedGitHead}`,
        );
      }
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${CLI_NAME}@${version} (${expectedGitHead}) to appear on npm`,
      );
    }
    console.log(`waiting for npm registry propagation of ${CLI_NAME}@${version}...`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5_000));
  }
}

function cliVersion(): string {
  return execFileSync("node", ["-p", "require('./package.json').version"], {
    cwd: join(REPO_ROOT, "apps/cli"),
    encoding: "utf8",
  }).trim();
}

export function collectPublishTargets(options: {
  repoRoot: string;
  skipNative: boolean;
  requiresNative: boolean;
  nativePlatforms?: readonly NativePlatform[] | undefined;
}): string[] {
  const platforms = options.nativePlatforms ?? NATIVE_PLATFORMS;
  const targets: string[] = [];
  if (!options.skipNative) {
    if (options.requiresNative) {
      for (const platform of platforms) {
        targets.push(platform.npmName);
      }
    } else {
      for (const platform of platforms) {
        const binPath = join(
          options.repoRoot,
          "native-packages",
          platform.id,
          "bin",
          platform.binaryName,
        );
        if (existsSync(binPath)) {
          targets.push(platform.npmName);
        }
      }
    }
  }
  targets.push(CLI_NAME);
  return targets;
}

export function findUnpublishedPackages(
  targetPackages: readonly string[],
  version: string,
  isPublished: (name: string, version: string) => boolean = alreadyPublished,
): string[] {
  return targetPackages.filter((name) => !isPublished(name, version));
}

export interface PublishReleaseRunOptions {
  repoRoot?: string;
  skipNative?: boolean;
  requiresNative?: boolean;
  version?: string;
  preState?: PreState;
  nativePlatforms?: readonly NativePlatform[];
  isAlreadyPublished?: (name: string, version: string) => boolean;
  requireCi?: (repoRoot: string) => Promise<void>;
  ensureScopedTag?: (options: {
    repoRoot: string;
    version: string;
    gitTag: string;
    mainRef?: string;
  }) => { action: "create" | "noop"; targetCommit: string };
  executePublish?: (context: {
    repoRoot: string;
    version: string;
    skipNative: boolean;
    requiresNative: boolean;
    policy: ReturnType<typeof releasePolicy>;
  }) => Promise<void>;
  log?: (message: string) => void;
}

export type PublishReleaseOutcome =
  | { status: "noop"; unpublished: []; tagAction: "create" | "noop"; targetCommit: string }
  | { status: "published"; unpublished: string[] };

async function executePublishFlow(context: {
  repoRoot: string;
  version: string;
  skipNative: boolean;
  requiresNative: boolean;
  policy: ReturnType<typeof releasePolicy>;
}): Promise<void> {
  const { repoRoot, version, skipNative, requiresNative, policy } = context;

  // Gate before any publish: a failing check must not strand engine packages on
  // the registry with no matching CLI release.
  console.log("\nrunning prepublishOnly...");
  run("bun", ["run", "prepublishOnly"], { cwd: repoRoot });

  if (!skipNative) {
    const packed: string[] = [];
    const missing: string[] = [];

    for (const platform of NATIVE_PLATFORMS) {
      const dir = join(repoRoot, "native-packages", platform.id);
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

      const packedPlatforms = NATIVE_PLATFORMS.filter((p) => packed.includes(p.id));
      // Verify every target package is already registered on npm before writing
      // any engine version, so an unregistered package (e.g. a new musl target)
      // cannot strand earlier packages half-published.
      assertNativePackagesRegistered(packedPlatforms.map((p) => p.npmName));

      for (const platform of packedPlatforms) {
        const dir = join(repoRoot, "native-packages", platform.id);
        if (alreadyPublished(platform.npmName, version)) {
          console.log(`\nskipping ${platform.npmName}@${version} (already published)`);
          continue;
        }
        console.log(`\npublishing ${platform.npmName}@${version}...`);
        // No --provenance: trusted publishing attests automatically, and the
        // flag is only needed for token-authenticated publishes.
        run(
          "npm",
          ["publish", dir, "--access", "public", "--ignore-scripts", "--tag", policy.distTag],
          { cwd: repoRoot },
        );
      }

      // Confirm every expected engine package is queryable at the exact release
      // version on npm before promoting the CLI package.
      const requiredNames = requiresNative
        ? NATIVE_PLATFORMS.map((p) => p.npmName)
        : packedPlatforms.map((p) => p.npmName);
      await waitForNativePackagesPublished(requiredNames, version);
    }
  } else {
    console.log("skipping native engine publish (--skip-native)");
  }

  const headSha = gitOptional(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!headSha || !SHA_RE.test(headSha)) {
    throw new Error("Unable to resolve current HEAD commit SHA");
  }

  const cliRecord = readNpmPackageRecord(CLI_NAME, version);
  if (cliRecord.status === "error") {
    throw new Error(`Failed to query npm registry for ${CLI_NAME}@${version}: ${cliRecord.error}`);
  }

  if (cliRecord.status === "found") {
    console.log(`\nskipping ${CLI_NAME}@${version} (already published)`);
  } else {
    console.log(`\npublishing ${CLI_NAME}@${version}...`);
    const packDir = mkdtempSync(join(tmpdir(), "sweep-pack-"));
    try {
      // `npm pack` runs prepack (resolve workspace:/catalog: and embed gitHead) and postpack.
      run("npm", ["pack", join(repoRoot, "apps/cli"), "--pack-destination", packDir], {
        cwd: repoRoot,
      });
      const tarball = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
      if (!tarball) throw new Error("npm pack produced no tarball");
      const tarballPath = join(packDir, tarball);
      run("tar", ["-xzf", tarballPath, "-C", packDir, "package/package.json"], { cwd: repoRoot });
      const manifest = JSON.parse(
        readFileSync(join(packDir, "package", "package.json"), "utf8"),
      ) as Record<string, unknown>;
      if (manifest.name !== CLI_NAME || manifest.version !== version)
        throw new Error(`Packed manifest is not ${CLI_NAME}@${version}`);
      if (manifest.gitHead !== headSha)
        throw new Error(
          `Packed manifest gitHead (${String(manifest.gitHead)}) does not match HEAD (${headSha})`,
        );
      // The registry's install metadata is exactly this manifest.
      assertPublishable(manifest);
      run("npm", ["publish", tarballPath, "--access", "public", "--tag", policy.distTag], {
        cwd: repoRoot,
      });
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
    await waitForCliPublishedWithGitHead(version, headSha);
  }

  // Only create a missing scoped tag at the verified npm `gitHead` commit (never
  // at the current checkout), and only after verifying `origin/main` ancestry.
  const tagResult = ensureScopedTagAtPublishedCommit({
    repoRoot,
    version,
    gitTag: policy.gitTag,
    mainRef: "origin/main",
  });
  if (tagResult.action === "create") {
    console.log(`🦋  New tag:  ${policy.gitTag}`);
  }

  const distFiles = existsSync(CLI_DIST_DIR) ? readdirSync(CLI_DIST_DIR) : [];
  console.log(`\nrelease complete (apps/cli/dist: ${distFiles.join(", ") || "empty"})`);
}

export async function runPublishRelease(
  options: PublishReleaseRunOptions = {},
): Promise<PublishReleaseOutcome> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const skipNative = options.skipNative ?? process.argv.includes("--skip-native");
  const requiresNative =
    options.requiresNative ??
    (process.env.CI === "true" || process.env.SWEEP_RELEASE_REQUIRES_NATIVE === "true");
  const version = options.version ?? cliVersion();
  const preFile = join(repoRoot, ".changeset/pre.json");
  const preState =
    options.preState !== undefined
      ? options.preState
      : existsSync(preFile)
        ? (JSON.parse(readFileSync(preFile, "utf8")) as PreState)
        : undefined;
  const policy = releasePolicy(version, preState);
  if (skipNative && requiresNative) {
    throw new Error(
      "CI publication requires the complete native matrix; --skip-native is not allowed",
    );
  }

  const log = options.log ?? ((msg: string) => console.log(msg));
  const isPublished = options.isAlreadyPublished ?? alreadyPublished;
  const requireCi = options.requireCi ?? requirePublicationCi;
  const ensureTag = options.ensureScopedTag ?? ensureScopedTagAtPublishedCommit;

  const targetPackages = collectPublishTargets({
    repoRoot,
    skipNative,
    requiresNative,
    nativePlatforms: options.nativePlatforms,
  });
  const unpublished = findUnpublishedPackages(targetPackages, version, isPublished);

  if (unpublished.length === 0) {
    const tagResult = ensureTag({
      repoRoot,
      version,
      gitTag: policy.gitTag,
      mainRef: "origin/main",
    });
    if (tagResult.action === "create") {
      log(`🦋  New tag:  ${policy.gitTag}`);
    }
    log(`All packages for ${version} are already published on npm; nothing to publish.`);
    return {
      status: "noop",
      unpublished: [],
      tagAction: tagResult.action,
      targetCommit: tagResult.targetCommit,
    };
  }

  await requireCi(repoRoot);

  const execute = options.executePublish ?? executePublishFlow;
  await execute({ repoRoot, version, skipNative, requiresNative, policy });

  return { status: "published", unpublished };
}

async function main(): Promise<void> {
  await runPublishRelease();
}

if (import.meta.main) {
  await main();
}
