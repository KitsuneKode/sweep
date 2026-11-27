#!/usr/bin/env bun
/**
 * Qualify a release tag (`vX.Y.Z`) before attaching standalone binaries to a
 * GitHub Release or updating downstream package managers (Homebrew, Scoop).
 *
 * Verifies:
 * 1. Canonical repository (`KitsuneKode/sweep`) and `refs/tags/v<semver>` ref
 * 2. Tag commit is reachable from canonical `origin/main`
 * 3. `apps/cli/package.json` at the tagged commit matches the tag version
 * 4. Scoped package tag (`@kitsunekode/sweep@X.Y.Z`), if present, points at the same commit
 * 5. Push CI (`ci.yml`) on `main` succeeded for the exact tagged commit
 * 6. Release workflow (`release.yml`) on `main` succeeded for the tagged commit
 *    (or for a descendant `main` commit during reconciliation, backed by durable
 *    scoped-tag + npm publication evidence)
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ciQualification } from "./release-ci.js";
import { releasePolicy } from "./release-policy.js";

export const CANONICAL_REPOSITORY = "KitsuneKode/sweep";
const CLI_NAME = "@kitsunekode/sweep";
const SHA_RE = /^[a-f0-9]{40}$/;

export interface WorkflowRunRecord {
  databaseId: number;
  headSha: string;
  headBranch: string;
  event: string;
  status: string;
  conclusion: string | null;
}

export interface ReleaseTagQualificationInput {
  repository: string;
  ref: string;
  tagSha: string | null;
  tagOnMain: boolean;
  packageVersionAtTag: string | null;
  packageTagSha: string | null;
  ciRuns: readonly WorkflowRunRecord[];
  releaseRuns: readonly WorkflowRunRecord[];
  /** Commits on main that are descendants of tagSha (inclusive) with a successful release.yml run. */
  releaseRunShaIsDescendantOfTag?: (sha: string) => boolean;
  npmPublished?: boolean;
  npmGitHead?: string | null;
}

export type ReleaseTagQualificationResult =
  | {
      ok: true;
      version: string;
      tag: string;
      tagSha: string;
      prerelease: boolean;
      qualificationMode: "direct-release" | "reconciled-release";
    }
  | {
      ok: false;
      waiting?: boolean;
      reason: string;
    };

export function evaluateReleaseTagQualification(
  input: ReleaseTagQualificationInput,
): ReleaseTagQualificationResult {
  if (input.repository !== CANONICAL_REPOSITORY) {
    return {
      ok: false,
      reason: `Refusing release tag outside canonical repository ${CANONICAL_REPOSITORY} (got ${input.repository || "empty"})`,
    };
  }

  if (!input.ref.startsWith("refs/tags/v")) {
    return {
      ok: false,
      reason: `Unsupported release ref ${JSON.stringify(input.ref)} (expected refs/tags/v<semver>)`,
    };
  }

  const tag = input.ref.slice("refs/tags/".length);
  const version = tag.slice(1);
  let policy: ReturnType<typeof releasePolicy>;
  try {
    policy = releasePolicy(version);
  } catch (error) {
    return {
      ok: false,
      reason: `Invalid release tag ${tag}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!input.tagSha || !SHA_RE.test(input.tagSha)) {
    return {
      ok: false,
      reason: `Tag ${tag} does not resolve to a valid commit SHA`,
    };
  }

  if (!input.tagOnMain) {
    return {
      ok: false,
      reason: `Tag ${tag} (${input.tagSha}) is not an ancestor of canonical main`,
    };
  }

  if (input.packageVersionAtTag !== version) {
    return {
      ok: false,
      reason: `apps/cli/package.json at ${input.tagSha} has version ${JSON.stringify(input.packageVersionAtTag)}, expected ${version}`,
    };
  }

  if (input.packageTagSha !== null) {
    if (!SHA_RE.test(input.packageTagSha)) {
      return {
        ok: false,
        reason: `Scoped tag ${policy.gitTag} has invalid commit SHA ${input.packageTagSha}`,
      };
    }
    if (input.packageTagSha !== input.tagSha) {
      return {
        ok: false,
        reason: `Scoped tag ${policy.gitTag} (${input.packageTagSha}) disagrees with ${tag} (${input.tagSha})`,
      };
    }
  }

  const ciState = ciQualification(
    input.ciRuns.map((run) => ({
      ...run,
      conclusion: run.conclusion ?? "",
    })),
    input.tagSha,
  );
  if (ciState === "waiting") {
    return {
      ok: false,
      waiting: true,
      reason: `Push CI (ci.yml) on main has not completed for ${input.tagSha}`,
    };
  }
  if (ciState === "failed") {
    return {
      ok: false,
      reason: `Push CI (ci.yml) on main failed for ${input.tagSha}`,
    };
  }

  const releaseOnMain = input.releaseRuns.filter(
    (run) =>
      run.headBranch === "main" && (run.event === "push" || run.event === "workflow_dispatch"),
  );

  // Direct match: a release.yml run on main for this exact tagged commit succeeded.
  const directSuccess = releaseOnMain.find(
    (run) =>
      run.headSha === input.tagSha && run.status === "completed" && run.conclusion === "success",
  );
  if (directSuccess) {
    return {
      ok: true,
      version,
      tag,
      tagSha: input.tagSha,
      prerelease: policy.prerelease,
      qualificationMode: "direct-release",
    };
  }

  // Reconciled match: a later release.yml run on main reconciled an already-published commit.
  const hasDurableNpmEvidence =
    input.npmPublished === true &&
    (input.npmGitHead === input.tagSha ||
      ((input.npmGitHead === null || input.npmGitHead === undefined) &&
        input.packageTagSha === input.tagSha));
  if (hasDurableNpmEvidence && input.releaseRunShaIsDescendantOfTag) {
    const reconciledSuccess = releaseOnMain.find(
      (run) =>
        run.status === "completed" &&
        run.conclusion === "success" &&
        SHA_RE.test(run.headSha) &&
        input.releaseRunShaIsDescendantOfTag!(run.headSha),
    );
    if (reconciledSuccess) {
      return {
        ok: true,
        version,
        tag,
        tagSha: input.tagSha,
        prerelease: policy.prerelease,
        qualificationMode: "reconciled-release",
      };
    }
  }

  // If a release.yml run for this exact commit (or a descendant during reconciliation)
  // is currently in progress, allow the caller to wait briefly for it to finish.
  const inFlightRelease = releaseOnMain.find(
    (run) =>
      run.status !== "completed" &&
      (run.headSha === input.tagSha ||
        (hasDurableNpmEvidence &&
          input.releaseRunShaIsDescendantOfTag !== undefined &&
          SHA_RE.test(run.headSha) &&
          input.releaseRunShaIsDescendantOfTag(run.headSha))),
  );
  if (inFlightRelease) {
    return {
      ok: false,
      waiting: true,
      reason: `Release workflow (release.yml) run ${inFlightRelease.databaseId} on main is still ${inFlightRelease.status}`,
    };
  }

  return {
    ok: false,
    reason: `No successful Release workflow (release.yml) run on main found for ${tag} (${input.tagSha})`,
  };
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

function listWorkflowRuns(
  repoRoot: string,
  repository: string,
  workflow: string,
  extraArgs: string[] = [],
): WorkflowRunRecord[] {
  const proc = spawnSync(
    "gh",
    [
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      workflow,
      "--branch",
      "main",
      "--limit",
      "20",
      "--json",
      "databaseId,headSha,headBranch,event,status,conclusion",
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (proc.status !== 0) {
    throw new Error(
      `gh run list --workflow ${workflow} failed (${proc.status}): ${proc.stderr.trim()}`,
    );
  }
  return JSON.parse(proc.stdout) as WorkflowRunRecord[];
}

function readNpmReleaseRecord(version: string): { published: boolean; gitHead: string | null } {
  const proc = spawnSync(
    "npm",
    ["view", `${CLI_NAME}@${version}`, "version", "gitHead", "--json"],
    {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (proc.status !== 0 || !proc.stdout.trim()) {
    return { published: false, gitHead: null };
  }
  const parsed = JSON.parse(proc.stdout) as string | { version?: string; gitHead?: string };
  if (typeof parsed === "string") {
    return { published: parsed.trim() === version, gitHead: null };
  }
  return {
    published: parsed.version === version,
    gitHead:
      typeof parsed.gitHead === "string" && SHA_RE.test(parsed.gitHead) ? parsed.gitHead : null,
  };
}

function parseArgs(argv: string[]): {
  repository: string;
  ref: string;
  mainRef: string;
  waitSeconds: number;
} {
  let repository = process.env.GITHUB_REPOSITORY ?? "";
  let ref = process.env.GITHUB_REF ?? "";
  let mainRef = "origin/main";
  let waitSeconds = 180;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") repository = argv[++i] ?? "";
    else if (arg === "--ref") ref = argv[++i] ?? "";
    else if (arg === "--main-ref") mainRef = argv[++i] ?? "";
    else if (arg === "--wait-seconds") {
      waitSeconds = Number.parseInt(argv[++i] ?? "180", 10);
      if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
        throw new Error(`Invalid --wait-seconds: ${argv[i]}`);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { repository, ref, mainRef, waitSeconds };
}

if (import.meta.main) {
  const { repository, ref, mainRef, waitSeconds } = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  const tag = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  const tagSha = tag
    ? gitOptional(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`])
    : null;
  const tagOnMain = tagSha !== null && gitIsAncestor(repoRoot, tagSha, mainRef);

  let packageVersionAtTag: string | null = null;
  if (tagSha) {
    const rawPkg = gitOptional(repoRoot, ["show", `${tagSha}:apps/cli/package.json`]);
    if (rawPkg) {
      try {
        const parsed = JSON.parse(rawPkg) as { version?: string };
        packageVersionAtTag = typeof parsed.version === "string" ? parsed.version : null;
      } catch {
        packageVersionAtTag = null;
      }
    }
  }

  const packageTag = version ? `${CLI_NAME}@${version}` : "";
  const packageTagSha = packageTag
    ? gitOptional(repoRoot, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/tags/${packageTag}^{commit}`,
      ])
    : null;

  const npmRecord = version ? readNpmReleaseRecord(version) : { published: false, gitHead: null };
  const deadline = Date.now() + waitSeconds * 1000;

  while (true) {
    const ciRuns =
      repository === CANONICAL_REPOSITORY && tagSha
        ? listWorkflowRuns(repoRoot, repository, "ci.yml", ["--commit", tagSha, "--event", "push"])
        : [];
    const releaseRuns =
      repository === CANONICAL_REPOSITORY && tagSha
        ? listWorkflowRuns(repoRoot, repository, "release.yml")
        : [];

    const result = evaluateReleaseTagQualification({
      repository,
      ref,
      tagSha,
      tagOnMain,
      packageVersionAtTag,
      packageTagSha,
      ciRuns,
      releaseRuns,
      releaseRunShaIsDescendantOfTag:
        tagSha === null
          ? undefined
          : (sha) => gitIsAncestor(repoRoot, tagSha, sha) && gitIsAncestor(repoRoot, sha, mainRef),
      npmPublished: npmRecord.published,
      npmGitHead: npmRecord.gitHead,
    });

    if (result.ok) {
      console.log(
        `verify-release-tag: qualified ${result.tag} (${result.tagSha}) via ${result.qualificationMode}`,
      );
      process.exit(0);
    }

    if (result.waiting && Date.now() < deadline) {
      console.log(`verify-release-tag: waiting (${result.reason})`);
      await new Promise<void>((r) => setTimeout(r, 10_000));
      continue;
    }

    console.error(`verify-release-tag: error: ${result.reason}`);
    process.exit(1);
  }
}
