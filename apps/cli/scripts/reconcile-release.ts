#!/usr/bin/env bun
/**
 * Idempotent release reconciliation between npm publication, git tags, and
 * GitHub Release standalone binaries (Codex A11).
 *
 * If npm already has the version but the `vX.Y.Z` tag or the expected binary
 * assets are missing, a rerun creates the tag on the exact released commit
 * (refusing a mismatched existing tag) and dispatches `cli-binaries.yml`.
 *
 * Usage:
 *   bun run apps/cli/scripts/reconcile-release.ts [--changesets-published true|false] [--dry-run]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePolicy } from "./release-policy.js";

const CLI_NAME = "@kitsunekode/sweep";
const SHA_RE = /^[a-f0-9]{40}$/;

export const DEFAULT_RELEASE_BINARY_TARGETS: readonly string[] = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-x64-musl",
  "linux-arm64",
  "linux-arm64-musl",
  "win-x64",
];

/** Extract matrix target IDs from `.github/workflows/cli-binaries.yml`. */
export function parseBinaryTargetsFromWorkflow(workflowYaml: string): string[] {
  const ids: string[] = [];
  for (const line of workflowYaml.split(/\r?\n/)) {
    const match = /^\s*-\s+id:\s+([a-z0-9-]+)\s*$/.exec(line);
    if (match?.[1]) {
      ids.push(match[1]);
    }
  }
  return ids;
}

/** Build the complete list of binary, archive, and checksum assets for a set of targets. */
export function expectedReleaseAssets(
  targets: readonly string[] = DEFAULT_RELEASE_BINARY_TARGETS,
): string[] {
  const assets: string[] = [];
  for (const id of targets) {
    const ext = id.startsWith("win-") ? ".exe" : "";
    for (const prefix of ["sweep", "sweep-engine"]) {
      const bin = `${prefix}-${id}${ext}`;
      assets.push(bin, `${bin}.sha256`, `${bin}.gz`, `${bin}.gz.sha256`);
    }
  }
  return assets;
}

export interface ReleaseReconciliationInput {
  version: string;
  headSha: string;
  /** Earliest contiguous first-parent commit where apps/cli/package.json carries `version`. */
  versionCommitSha?: string | null;
  changesetsPublished: boolean;
  npmPublished: boolean;
  npmGitHead: string | null;
  packageTagSha: string | null;
  binaryTagSha: string | null;
  releaseAssets: readonly string[];
  expectedAssets?: readonly string[];
}

export type ReleaseReconciliationPlan =
  | {
      kind: "skip";
      reason: string;
      binaryTag: string;
      packageTag: string;
    }
  | {
      kind: "noop";
      reason: string;
      binaryTag: string;
      packageTag: string;
      targetCommit: string;
    }
  | {
      kind: "error";
      reason: string;
      binaryTag: string;
      packageTag: string;
      targetCommit?: string;
    }
  | {
      kind: "reconcile";
      binaryTag: string;
      packageTag: string;
      targetCommit: string;
      createBinaryTag: boolean;
      pushBinaryTag: boolean;
      dispatchWorkflow: boolean;
      missingAssets: string[];
    };

export function planReleaseReconciliation(
  state: ReleaseReconciliationInput,
): ReleaseReconciliationPlan {
  const policy = releasePolicy(state.version);
  const packageTag = policy.gitTag;
  const binaryTag = `v${state.version}`;

  if (!SHA_RE.test(state.headSha)) {
    return {
      kind: "error",
      reason: `Invalid HEAD commit SHA: ${state.headSha}`,
      binaryTag,
      packageTag,
    };
  }

  if (!state.npmPublished && !state.changesetsPublished) {
    return {
      kind: "skip",
      reason: `${CLI_NAME}@${state.version} is not published on npm yet`,
      binaryTag,
      packageTag,
    };
  }

  for (const [label, sha] of [
    [packageTag, state.packageTagSha],
    ["npm gitHead", state.npmGitHead],
    ["version commit", state.versionCommitSha ?? null],
    [binaryTag, state.binaryTagSha],
  ] as const) {
    if (sha !== null && !SHA_RE.test(sha)) {
      return {
        kind: "error",
        reason: `Invalid commit SHA for ${label}: ${sha}`,
        binaryTag,
        packageTag,
      };
    }
  }

  if (state.changesetsPublished && state.packageTagSha && state.packageTagSha !== state.headSha) {
    return {
      kind: "error",
      reason: `Package release tag ${packageTag} (${state.packageTagSha}) does not match checked-out HEAD (${state.headSha})`,
      binaryTag,
      packageTag,
    };
  }

  if (state.packageTagSha && state.npmGitHead && state.packageTagSha !== state.npmGitHead) {
    return {
      kind: "error",
      reason: `Package release tag ${packageTag} (${state.packageTagSha}) disagrees with npm gitHead (${state.npmGitHead})`,
      binaryTag,
      packageTag,
    };
  }

  const targetCommit =
    state.packageTagSha ?? state.npmGitHead ?? state.versionCommitSha ?? state.headSha;
  if (state.changesetsPublished && targetCommit !== state.headSha) {
    return {
      kind: "error",
      reason: `Published commit (${targetCommit}) does not match checked-out HEAD (${state.headSha})`,
      binaryTag,
      packageTag,
      targetCommit,
    };
  }

  if (state.binaryTagSha && state.binaryTagSha !== targetCommit) {
    return {
      kind: "error",
      reason: `Existing binary tag ${binaryTag} points to ${state.binaryTagSha}, expected released commit ${targetCommit}; refusing to move tag`,
      binaryTag,
      packageTag,
      targetCommit,
    };
  }

  const expected = state.expectedAssets ?? expectedReleaseAssets();
  const present = new Set(state.releaseAssets);
  const missingAssets = expected.filter((asset) => !present.has(asset));

  const createBinaryTag = state.binaryTagSha === null;
  const dispatchWorkflow = createBinaryTag || missingAssets.length > 0;

  if (!createBinaryTag && !dispatchWorkflow) {
    return {
      kind: "noop",
      reason: `${binaryTag} and all ${expected.length} release assets are already present on ${targetCommit}`,
      binaryTag,
      packageTag,
      targetCommit,
    };
  }

  return {
    kind: "reconcile",
    binaryTag,
    packageTag,
    targetCommit,
    createBinaryTag,
    pushBinaryTag: createBinaryTag,
    dispatchWorkflow,
    missingAssets,
  };
}

function gitOptional(repoRoot: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const out = result.stdout.trim();
  return out.length > 0 ? out : null;
}

function runCommand(repoRoot: string, command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${String(result.status)}`);
  }
}

/**
 * Find the earliest contiguous first-parent commit touching apps/cli/package.json
 * that carries `version` (i.e. the commit that bumped the package to `version`).
 */
export function findVersionCommitSha(repoRoot: string, version: string): string | null {
  const log = gitOptional(repoRoot, [
    "log",
    "--first-parent",
    "--format=%H",
    "--",
    "apps/cli/package.json",
  ]);
  if (!log) return null;

  let earliestMatch: string | null = null;
  for (const sha of log.split(/\r?\n/)) {
    const trimmed = sha.trim();
    if (!SHA_RE.test(trimmed)) continue;
    const raw = gitOptional(repoRoot, ["show", `${trimmed}:apps/cli/package.json`]);
    if (!raw) break;
    try {
      const parsed = JSON.parse(raw) as { version?: string };
      if (parsed.version === version) {
        earliestMatch = trimmed;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return earliestMatch;
}

function readNpmReleaseInfo(version: string): { published: boolean; gitHead: string | null } {
  const result = spawnSync(
    "npm",
    ["view", `${CLI_NAME}@${version}`, "version", "gitHead", "--json"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    return { published: false, gitHead: null };
  }
  const parsed = JSON.parse(result.stdout) as string | { version?: string; gitHead?: string };
  if (typeof parsed === "string") {
    return { published: parsed.trim() === version, gitHead: null };
  }
  const published = parsed.version === version;
  const gitHead =
    typeof parsed.gitHead === "string" && SHA_RE.test(parsed.gitHead) ? parsed.gitHead : null;
  return { published, gitHead };
}

function readGitHubReleaseAssets(repoRoot: string, binaryTag: string): string[] {
  const result = spawnSync(
    "gh",
    ["release", "view", binaryTag, "--json", "assets", "--jq", ".assets[].name"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function expectedAssetsForCommit(repoRoot: string, commit: string): string[] {
  const yaml = gitOptional(repoRoot, ["show", `${commit}:.github/workflows/cli-binaries.yml`]);
  if (yaml) {
    const parsed = parseBinaryTargetsFromWorkflow(yaml);
    if (parsed.length > 0) {
      return expectedReleaseAssets(parsed);
    }
  }
  return expectedReleaseAssets(DEFAULT_RELEASE_BINARY_TARGETS);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const pubIdx = argv.indexOf("--changesets-published");
  const changesetsPublished = pubIdx >= 0 && argv[pubIdx + 1] === "true";

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const cliPkg = JSON.parse(readFileSync(join(repoRoot, "apps/cli/package.json"), "utf8")) as {
    version: string;
  };
  const version = cliPkg.version;
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();

  const packageTag = `${CLI_NAME}@${version}`;
  const binaryTag = `v${version}`;
  const packageTagSha = gitOptional(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/tags/${packageTag}^{commit}`,
  ]);
  const binaryTagSha = gitOptional(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/tags/${binaryTag}^{commit}`,
  ]);
  const versionCommitSha = findVersionCommitSha(repoRoot, version);

  const npmInfo = readNpmReleaseInfo(version);
  const probeCommit = packageTagSha ?? npmInfo.gitHead ?? versionCommitSha ?? headSha;
  const expected = expectedAssetsForCommit(repoRoot, probeCommit);
  const releaseAssets =
    npmInfo.published || changesetsPublished ? readGitHubReleaseAssets(repoRoot, binaryTag) : [];

  const plan = planReleaseReconciliation({
    version,
    headSha,
    versionCommitSha,
    changesetsPublished,
    npmPublished: npmInfo.published,
    npmGitHead: npmInfo.gitHead,
    packageTagSha,
    binaryTagSha,
    releaseAssets,
    expectedAssets: expected,
  });

  if (plan.kind === "skip" || plan.kind === "noop") {
    console.log(`reconcile-release: ${plan.kind} (${plan.reason})`);
    process.exit(0);
  }

  if (plan.kind === "error") {
    console.error(`reconcile-release: error: ${plan.reason}`);
    process.exit(1);
  }

  // Confirm the target commit is actually present in local git history.
  const verified = gitOptional(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${plan.targetCommit}^{commit}`,
  ]);
  if (!verified || verified !== plan.targetCommit) {
    console.error(
      `reconcile-release: error: target commit ${plan.targetCommit} is not present in this git checkout`,
    );
    process.exit(1);
  }

  console.log(
    `reconcile-release: reconciling ${plan.binaryTag} on ${plan.targetCommit} ` +
      `(createBinaryTag=${plan.createBinaryTag}, dispatchWorkflow=${plan.dispatchWorkflow}, ` +
      `missingAssets=${plan.missingAssets.length})`,
  );

  if (dryRun) {
    process.exit(0);
  }

  if (plan.createBinaryTag) {
    runCommand(repoRoot, "git", ["tag", plan.binaryTag, plan.targetCommit]);
  }
  if (plan.pushBinaryTag) {
    runCommand(repoRoot, "git", ["push", "origin", `refs/tags/${plan.binaryTag}`]);
  }
  if (plan.dispatchWorkflow) {
    runCommand(repoRoot, "gh", ["workflow", "run", "cli-binaries.yml", "--ref", plan.binaryTag]);
  }
}
