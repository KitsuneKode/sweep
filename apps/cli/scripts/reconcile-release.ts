#!/usr/bin/env bun
/**
 * Idempotent release reconciliation between npm publication, git tags,
 * GitHub Release standalone binaries, and downstream Homebrew/Scoop channels.
 *
 * Requires canonical repository (`KitsuneKode/sweep`) and `refs/heads/main`,
 * authoritative publication commit evidence (npm `gitHead` or scoped tag
 * `@kitsunekode/sweep@X.Y.Z`, never a version-bump log heuristic), canonical
 * main ancestry, and exact version match at the target commit. Deduplicates
 * in-flight/queued `cli-binaries.yml` runs and tracks Homebrew/Scoop updates
 * separately without downgrading.
 *
 * Usage:
 *   bun run apps/cli/scripts/reconcile-release.ts \
 *     [--repo KitsuneKode/sweep] [--ref refs/heads/main] \
 *     [--changesets-published true|false] [--dry-run]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePolicy } from "./release-policy.js";
import {
  compareSemver,
  extractHomebrewFormulaVersion,
  extractScoopManifestVersion,
} from "./render-packaging.js";

export const CANONICAL_REPOSITORY = "KitsuneKode/sweep";
export const CANONICAL_REF = "refs/heads/main";
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

const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

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

export type NpmReleaseLookup =
  | { status: "found"; gitHead: string | null }
  | { status: "not_found" }
  | { status: "error"; error: string };

export type GitHubReleaseAssetsLookup =
  | { status: "found"; assets: readonly string[] }
  | { status: "not_found" }
  | { status: "error"; error: string };

export interface BinaryWorkflowRun {
  databaseId: number;
  status: string;
  headBranch: string;
  headSha: string;
}

export type ActiveBinaryRunsLookup =
  | { status: "ok"; runs: readonly BinaryWorkflowRun[] }
  | { status: "error"; error: string };

export type DownstreamVersionLookup =
  | { status: "found"; version: string }
  | { status: "not_found" }
  | { status: "error"; error: string };

export type DownstreamTarget = "all" | "homebrew" | "scoop";
export type DispatchTarget = "all" | "downstream";

export interface ReleaseReconciliationInput {
  repository?: string;
  ref?: string;
  version: string;
  headSha: string;
  changesetsPublished: boolean;
  npm: NpmReleaseLookup;
  packageTagSha: string | null;
  binaryTagSha: string | null;
  /** Whether the resolved authoritative target commit is on canonical main. */
  targetCommitOnMain: boolean;
  /** `apps/cli/package.json` version read from the resolved target commit. */
  targetCommitPackageVersion: string | null;
  releaseAssets: GitHubReleaseAssetsLookup;
  activeBinaryRuns: ActiveBinaryRunsLookup;
  homebrew: DownstreamVersionLookup;
  scoop: DownstreamVersionLookup;
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
      activeRunId?: number;
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
      dispatchTarget: DispatchTarget;
      dispatchDownstream: DownstreamTarget;
      homebrewNeedsUpdate: boolean;
      scoopNeedsUpdate: boolean;
      missingAssets: string[];
    };

function evaluateDownstreamNeed(
  lookup: DownstreamVersionLookup,
  targetVersion: string,
  label: string,
):
  | { ok: true; needsUpdate: boolean; state: "missing" | "behind" | "current" | "newer" }
  | {
      ok: false;
      error: string;
    } {
  if (lookup.status === "error") {
    return { ok: false, error: `Failed to inspect ${label}: ${lookup.error}` };
  }
  if (lookup.status === "not_found") {
    return { ok: true, needsUpdate: true, state: "missing" };
  }
  let cmp: number;
  try {
    cmp = compareSemver(lookup.version, targetVersion);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid version in ${label} (${lookup.version}): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (cmp < 0) return { ok: true, needsUpdate: true, state: "behind" };
  if (cmp > 0) return { ok: true, needsUpdate: false, state: "newer" };
  return { ok: true, needsUpdate: false, state: "current" };
}

export function planReleaseReconciliation(
  state: ReleaseReconciliationInput,
): ReleaseReconciliationPlan {
  const policy = releasePolicy(state.version);
  const packageTag = policy.gitTag;
  const binaryTag = `v${state.version}`;

  if (state.repository !== undefined && state.repository !== CANONICAL_REPOSITORY) {
    return {
      kind: "error",
      reason: `Refusing to reconcile outside canonical repository ${CANONICAL_REPOSITORY} (got ${state.repository || "empty"})`,
      binaryTag,
      packageTag,
    };
  }

  if (state.ref !== undefined && state.ref !== CANONICAL_REF) {
    return {
      kind: "error",
      reason: `Refusing to reconcile outside ${CANONICAL_REF} (got ${state.ref || "empty"})`,
      binaryTag,
      packageTag,
    };
  }

  if (!SHA_RE.test(state.headSha)) {
    return {
      kind: "error",
      reason: `Invalid HEAD commit SHA: ${state.headSha}`,
      binaryTag,
      packageTag,
    };
  }

  if (state.npm.status === "error") {
    return {
      kind: "error",
      reason: `Failed to query npm for ${CLI_NAME}@${state.version}: ${state.npm.error}`,
      binaryTag,
      packageTag,
    };
  }

  const npmPublished = state.npm.status === "found";
  const npmGitHead = state.npm.status === "found" ? state.npm.gitHead : null;

  if (!npmPublished && !state.changesetsPublished) {
    return {
      kind: "skip",
      reason: `${CLI_NAME}@${state.version} is not published on npm yet`,
      binaryTag,
      packageTag,
    };
  }

  for (const [label, sha] of [
    [packageTag, state.packageTagSha],
    ["npm gitHead", npmGitHead],
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

  if (state.packageTagSha && npmGitHead && state.packageTagSha !== npmGitHead) {
    return {
      kind: "error",
      reason: `Package release tag ${packageTag} (${state.packageTagSha}) disagrees with npm gitHead (${npmGitHead})`,
      binaryTag,
      packageTag,
    };
  }

  // Authoritative publication commit: npm gitHead when present, otherwise the
  // durable scoped package tag. Never guess from version-bump git log history.
  const targetCommit = npmGitHead ?? state.packageTagSha;
  if (!targetCommit) {
    return {
      kind: "error",
      reason: `Refusing to reconcile ${CLI_NAME}@${state.version}: missing authoritative publication commit (both npm gitHead and ${packageTag} tag are absent)`,
      binaryTag,
      packageTag,
    };
  }

  if (state.changesetsPublished && targetCommit !== state.headSha) {
    return {
      kind: "error",
      reason: `Published commit (${targetCommit}) does not match checked-out HEAD (${state.headSha})`,
      binaryTag,
      packageTag,
      targetCommit,
    };
  }

  if (!state.targetCommitOnMain) {
    return {
      kind: "error",
      reason: `Authoritative release commit ${targetCommit} is not on canonical main`,
      binaryTag,
      packageTag,
      targetCommit,
    };
  }

  if (state.targetCommitPackageVersion !== state.version) {
    return {
      kind: "error",
      reason: `apps/cli/package.json at ${targetCommit} has version ${JSON.stringify(state.targetCommitPackageVersion)}, expected ${state.version}`,
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

  if (state.releaseAssets.status === "error") {
    return {
      kind: "error",
      reason: `Failed to query GitHub Release ${binaryTag}: ${state.releaseAssets.error}`,
      binaryTag,
      packageTag,
      targetCommit,
    };
  }

  if (state.activeBinaryRuns.status === "error") {
    return {
      kind: "error",
      reason: `Failed to query active cli-binaries.yml runs: ${state.activeBinaryRuns.error}`,
      binaryTag,
      packageTag,
      targetCommit,
    };
  }

  const expected = state.expectedAssets ?? expectedReleaseAssets();
  const present = new Set(state.releaseAssets.status === "found" ? state.releaseAssets.assets : []);
  const missingAssets = expected.filter((asset) => !present.has(asset));

  let homebrewNeedsUpdate = false;
  let scoopNeedsUpdate = false;
  if (!policy.prerelease) {
    const hb = evaluateDownstreamNeed(state.homebrew, state.version, "Homebrew tap");
    if (!hb.ok) {
      return { kind: "error", reason: hb.error, binaryTag, packageTag, targetCommit };
    }
    const sc = evaluateDownstreamNeed(state.scoop, state.version, "Scoop bucket");
    if (!sc.ok) {
      return { kind: "error", reason: sc.error, binaryTag, packageTag, targetCommit };
    }
    homebrewNeedsUpdate = hb.needsUpdate;
    scoopNeedsUpdate = sc.needsUpdate;
  }

  const createBinaryTag = state.binaryTagSha === null;
  const needsBinaryBuild = createBinaryTag || missingAssets.length > 0;
  const needsDownstreamOnly = !needsBinaryBuild && (homebrewNeedsUpdate || scoopNeedsUpdate);

  if (!needsBinaryBuild && !needsDownstreamOnly) {
    return {
      kind: "noop",
      reason: `${binaryTag}, all ${expected.length} release assets, and downstream channels are already up to date on ${targetCommit}`,
      binaryTag,
      packageTag,
      targetCommit,
    };
  }

  // Deduplicate active cli-binaries.yml runs for the exact same tag and commit.
  const matchingActiveRun = state.activeBinaryRuns.runs.find(
    (run) =>
      ACTIVE_RUN_STATUSES.has(run.status) &&
      run.headBranch === binaryTag &&
      run.headSha === targetCommit,
  );
  if (!createBinaryTag && matchingActiveRun) {
    return {
      kind: "noop",
      reason: `cli-binaries.yml run ${matchingActiveRun.databaseId} (${matchingActiveRun.status}) is already active for ${binaryTag} on ${targetCommit}; skipping duplicate dispatch`,
      binaryTag,
      packageTag,
      targetCommit,
      activeRunId: matchingActiveRun.databaseId,
    };
  }

  const dispatchTarget: DispatchTarget = needsBinaryBuild ? "all" : "downstream";
  let dispatchDownstream: DownstreamTarget = "all";
  if (!policy.prerelease) {
    if (homebrewNeedsUpdate && scoopNeedsUpdate) dispatchDownstream = "all";
    else if (homebrewNeedsUpdate) dispatchDownstream = "homebrew";
    else if (scoopNeedsUpdate) dispatchDownstream = "scoop";
  }

  return {
    kind: "reconcile",
    binaryTag,
    packageTag,
    targetCommit,
    createBinaryTag,
    pushBinaryTag: createBinaryTag,
    dispatchWorkflow: true,
    dispatchTarget,
    dispatchDownstream,
    homebrewNeedsUpdate,
    scoopNeedsUpdate,
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

function gitIsAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return result.status === 0;
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

export interface ReleaseClients {
  readNpmRelease(version: string): NpmReleaseLookup;
  readGitHubReleaseAssets(repository: string, binaryTag: string): GitHubReleaseAssetsLookup;
  listActiveBinaryRuns(repository: string): ActiveBinaryRunsLookup;
  readHomebrewVersion(): DownstreamVersionLookup;
  readScoopVersion(): DownstreamVersionLookup;
  dispatchCliBinaries(
    repository: string,
    binaryTag: string,
    target: DispatchTarget,
    downstream: DownstreamTarget,
  ): void;
}

function isNotFoundStderr(text: string): boolean {
  return /\b404\b|HTTP 404|Not Found|release not found/i.test(text);
}

function readGitHubFileContent(
  repoRoot: string,
  targetRepo: string,
  filePath: string,
):
  | { status: "found"; content: string }
  | { status: "not_found" }
  | { status: "error"; error: string } {
  const proc = spawnSync(
    "gh",
    ["api", `repos/${targetRepo}/contents/${filePath}`, "--jq", ".content"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (proc.status !== 0) {
    const combined = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`.trim();
    if (isNotFoundStderr(combined)) {
      return { status: "not_found" };
    }
    return {
      status: "error",
      error:
        combined || `gh api repos/${targetRepo}/contents/${filePath} exited ${String(proc.status)}`,
    };
  }
  const b64 = proc.stdout.replace(/\s+/g, "");
  return { status: "found", content: Buffer.from(b64, "base64").toString("utf8") };
}

export function createLiveReleaseClients(repoRoot: string): ReleaseClients {
  return {
    readNpmRelease(version: string): NpmReleaseLookup {
      const result = spawnSync(
        "npm",
        ["view", `${CLI_NAME}@${version}`, "version", "gitHead", "--json"],
        {
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const stdout = result.stdout?.trim() ?? "";
      const stderr = result.stderr?.trim() ?? "";
      if (result.status !== 0) {
        const combined = `${stdout}\n${stderr}`;
        if (/\bE404\b|404 Not Found|is not in this registry/i.test(combined)) {
          return { status: "not_found" };
        }
        return {
          status: "error",
          error: combined.trim() || `npm view exited with status ${String(result.status)}`,
        };
      }
      if (!stdout) return { status: "not_found" };
      const parsed = JSON.parse(stdout) as string | { version?: string; gitHead?: string };
      if (typeof parsed === "string") {
        return parsed.trim() === version
          ? { status: "found", gitHead: null }
          : { status: "not_found" };
      }
      if (parsed.version !== version) return { status: "not_found" };
      const gitHead =
        typeof parsed.gitHead === "string" && SHA_RE.test(parsed.gitHead) ? parsed.gitHead : null;
      return { status: "found", gitHead };
    },

    readGitHubReleaseAssets(repository: string, binaryTag: string): GitHubReleaseAssetsLookup {
      const proc = spawnSync(
        "gh",
        ["api", `repos/${repository}/releases/tags/${binaryTag}`, "--jq", ".assets[].name"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (proc.status !== 0) {
        const combined = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`.trim();
        if (isNotFoundStderr(combined)) {
          return { status: "not_found" };
        }
        return {
          status: "error",
          error: combined || `gh api release lookup exited ${String(proc.status)}`,
        };
      }
      const assets = proc.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return { status: "found", assets };
    },

    listActiveBinaryRuns(repository: string): ActiveBinaryRunsLookup {
      const proc = spawnSync(
        "gh",
        [
          "run",
          "list",
          "--repo",
          repository,
          "--workflow",
          "cli-binaries.yml",
          "--limit",
          "20",
          "--json",
          "databaseId,status,headBranch,headSha",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (proc.status !== 0) {
        const combined = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`.trim();
        return {
          status: "error",
          error: combined || `gh run list exited ${String(proc.status)}`,
        };
      }
      const runs = JSON.parse(proc.stdout) as BinaryWorkflowRun[];
      return { status: "ok", runs };
    },

    readHomebrewVersion(): DownstreamVersionLookup {
      const file = readGitHubFileContent(repoRoot, "KitsuneKode/homebrew-tap", "Formula/sweep.rb");
      if (file.status !== "found") return file;
      const version = extractHomebrewFormulaVersion(file.content);
      if (!version) {
        return {
          status: "error",
          error: "Formula/sweep.rb does not declare a parseable version",
        };
      }
      return { status: "found", version };
    },

    readScoopVersion(): DownstreamVersionLookup {
      const file = readGitHubFileContent(repoRoot, "KitsuneKode/scoop-bucket", "bucket/sweep.json");
      if (file.status !== "found") return file;
      const version = extractScoopManifestVersion(file.content);
      if (!version) {
        return {
          status: "error",
          error: "bucket/sweep.json does not declare a parseable version",
        };
      }
      return { status: "found", version };
    },

    dispatchCliBinaries(
      repository: string,
      binaryTag: string,
      target: DispatchTarget,
      downstream: DownstreamTarget,
    ): void {
      runCommand(repoRoot, "gh", [
        "workflow",
        "run",
        "cli-binaries.yml",
        "--repo",
        repository,
        "--ref",
        binaryTag,
        "-f",
        `target=${target}`,
        "-f",
        `downstream=${downstream}`,
      ]);
    },
  };
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

function packageVersionAtCommit(repoRoot: string, commit: string): string | null {
  const raw = gitOptional(repoRoot, ["show", `${commit}:apps/cli/package.json`]);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export interface ReconcileOptions {
  repoRoot: string;
  repository: string;
  ref: string;
  mainRef?: string;
  remoteName?: string;
  changesetsPublished: boolean;
  dryRun: boolean;
}

export function runReconcileRelease(
  options: ReconcileOptions,
  clients: ReleaseClients = createLiveReleaseClients(options.repoRoot),
): ReleaseReconciliationPlan {
  const { repoRoot, repository, ref, changesetsPublished, dryRun } = options;
  const mainRef = options.mainRef ?? "origin/main";
  const remoteName = options.remoteName ?? "origin";

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

  const npm = clients.readNpmRelease(version);
  const authoritativeCommit = (npm.status === "found" ? npm.gitHead : null) ?? packageTagSha;
  const resolvedMainRef =
    gitOptional(repoRoot, ["rev-parse", "--verify", "--quiet", `${mainRef}^{commit}`]) !== null
      ? mainRef
      : "HEAD";

  const targetCommitOnMain =
    authoritativeCommit !== null && gitIsAncestor(repoRoot, authoritativeCommit, resolvedMainRef);
  const targetCommitPackageVersion =
    authoritativeCommit !== null ? packageVersionAtCommit(repoRoot, authoritativeCommit) : null;

  const expected =
    authoritativeCommit !== null
      ? expectedAssetsForCommit(repoRoot, authoritativeCommit)
      : expectedReleaseAssets(DEFAULT_RELEASE_BINARY_TARGETS);

  const shouldProbeRelease = npm.status === "found" || changesetsPublished;
  const releaseAssets: GitHubReleaseAssetsLookup = shouldProbeRelease
    ? clients.readGitHubReleaseAssets(repository, binaryTag)
    : { status: "not_found" };
  const activeBinaryRuns: ActiveBinaryRunsLookup = shouldProbeRelease
    ? clients.listActiveBinaryRuns(repository)
    : { status: "ok", runs: [] };
  const homebrew: DownstreamVersionLookup = shouldProbeRelease
    ? clients.readHomebrewVersion()
    : { status: "not_found" };
  const scoop: DownstreamVersionLookup = shouldProbeRelease
    ? clients.readScoopVersion()
    : { status: "not_found" };

  const plan = planReleaseReconciliation({
    repository,
    ref,
    version,
    headSha,
    changesetsPublished,
    npm,
    packageTagSha,
    binaryTagSha,
    targetCommitOnMain,
    targetCommitPackageVersion,
    releaseAssets,
    activeBinaryRuns,
    homebrew,
    scoop,
    expectedAssets: expected,
  });

  if (plan.kind !== "reconcile" || dryRun) {
    return plan;
  }

  // Confirm the target commit is present in local git history.
  const verified = gitOptional(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${plan.targetCommit}^{commit}`,
  ]);
  if (!verified || verified !== plan.targetCommit) {
    return {
      kind: "error",
      reason: `target commit ${plan.targetCommit} is not present in this git checkout`,
      binaryTag: plan.binaryTag,
      packageTag: plan.packageTag,
      targetCommit: plan.targetCommit,
    };
  }

  if (plan.createBinaryTag) {
    runCommand(repoRoot, "git", ["tag", plan.binaryTag, plan.targetCommit]);
  }
  if (plan.pushBinaryTag) {
    runCommand(repoRoot, "git", ["push", remoteName, `refs/tags/${plan.binaryTag}`]);
  }
  if (plan.dispatchWorkflow) {
    clients.dispatchCliBinaries(
      repository,
      plan.binaryTag,
      plan.dispatchTarget,
      plan.dispatchDownstream,
    );
  }

  return plan;
}

function parseCliArgs(argv: string[]): {
  dryRun: boolean;
  changesetsPublished: boolean;
  repository: string;
  ref: string;
} {
  let dryRun = false;
  let changesetsPublished = false;
  let repository = process.env.GITHUB_REPOSITORY ?? CANONICAL_REPOSITORY;
  let ref = process.env.GITHUB_REF ?? CANONICAL_REF;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--changesets-published") changesetsPublished = argv[++i] === "true";
    else if (arg === "--repo") repository = argv[++i] ?? "";
    else if (arg === "--ref") ref = argv[++i] ?? "";
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return { dryRun, changesetsPublished, repository, ref };
}

if (import.meta.main) {
  const { dryRun, changesetsPublished, repository, ref } = parseCliArgs(process.argv.slice(2));
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  const plan = runReconcileRelease({
    repoRoot,
    repository,
    ref,
    changesetsPublished,
    dryRun,
  });

  if (plan.kind === "skip" || plan.kind === "noop") {
    console.log(`reconcile-release: ${plan.kind} (${plan.reason})`);
    process.exit(0);
  }

  if (plan.kind === "error") {
    console.error(`reconcile-release: error: ${plan.reason}`);
    process.exit(1);
  }

  console.log(
    `reconcile-release: ${dryRun ? "would reconcile" : "reconciled"} ${plan.binaryTag} on ${plan.targetCommit} ` +
      `(createBinaryTag=${plan.createBinaryTag}, target=${plan.dispatchTarget}, ` +
      `downstream=${plan.dispatchDownstream}, missingAssets=${plan.missingAssets.length}, ` +
      `homebrewNeedsUpdate=${plan.homebrewNeedsUpdate}, scoopNeedsUpdate=${plan.scoopNeedsUpdate})`,
  );
}
