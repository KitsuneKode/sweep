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
 * 5. Independent npm publication identity: `@kitsunekode/sweep@X.Y.Z` is published on npm
 *    with `gitHead` matching the exact tagged commit (legacy releases without `gitHead`
 *    refuse automatic qualification and print the manual path)
 * 6. Push CI (`ci.yml`) on `main` succeeded for the exact tagged commit
 * 7. Release workflow (`release.yml`) on `main` succeeded for the tagged commit
 *    (or for a descendant `main` commit during reconciliation)
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

export interface NpmReleaseRecord {
  published: boolean;
  gitHead: string | null;
  error?: string;
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
  npmPublished: boolean;
  npmGitHead: string | null;
  npmError?: string;
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

export function legacyManualQualificationMessage(
  version: string,
  tag: string,
  commitSha: string | null,
): string {
  const commitHint = commitSha ? ` against commit ${commitSha}` : "";
  return (
    `Refusing automatic qualification for ${tag}: published ${CLI_NAME}@${version} on npm has no gitHead metadata (legacy release). ` +
    `Manual path: verify the published npm tarball${commitHint}, create or verify tags manually, and upload GitHub Release assets / update downstream manifests with maintainer review.`
  );
}

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

  const releaseOnMain = input.releaseRuns.filter(
    (run) =>
      run.headBranch === "main" && (run.event === "push" || run.event === "workflow_dispatch"),
  );

  // Independently verify npm publication identity BEFORE accepting either a
  // direct or reconciled release.yml pass: release.yml can succeed after
  // opening a version PR or skipping an already-published version.
  if (input.npmError) {
    return {
      ok: false,
      reason: `Failed to verify npm publication identity for ${CLI_NAME}@${version}: ${input.npmError}`,
    };
  }

  if (!input.npmPublished) {
    const inFlightDirect = releaseOnMain.find(
      (run) => run.status !== "completed" && run.headSha === input.tagSha,
    );
    if (inFlightDirect) {
      return {
        ok: false,
        waiting: true,
        reason: `${CLI_NAME}@${version} is not yet visible on npm while Release workflow (release.yml) run ${inFlightDirect.databaseId} on main is still ${inFlightDirect.status}`,
      };
    }
    return {
      ok: false,
      reason: `Refusing to qualify ${tag}: ${CLI_NAME}@${version} is not published on npm`,
    };
  }

  if (!input.npmGitHead) {
    return {
      ok: false,
      reason: legacyManualQualificationMessage(version, tag, input.tagSha),
    };
  }

  if (!SHA_RE.test(input.npmGitHead)) {
    return {
      ok: false,
      reason: `Published ${CLI_NAME}@${version} on npm has invalid gitHead ${JSON.stringify(input.npmGitHead)}`,
    };
  }

  if (input.npmGitHead !== input.tagSha) {
    return {
      ok: false,
      reason: `Published ${CLI_NAME}@${version} on npm has gitHead ${input.npmGitHead}, which does not match ${tag} (${input.tagSha})`,
    };
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

  // Direct match: a release.yml run on main for this exact tagged commit succeeded
  // AND npm gitHead independently matched tagSha above.
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

  // Reconciled match: a later release.yml run on main reconciled an already-published commit
  // whose npm gitHead independently matched tagSha above.
  if (input.releaseRunShaIsDescendantOfTag) {
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
        (input.releaseRunShaIsDescendantOfTag !== undefined &&
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
  env: NodeJS.ProcessEnv = process.env,
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
      env,
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

export function readNpmReleaseRecord(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): NpmReleaseRecord {
  const proc = spawnSync(
    "npm",
    ["view", `${CLI_NAME}@${version}`, "version", "gitHead", "--json"],
    {
      env,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = proc.stdout?.trim() ?? "";
  const stderr = proc.stderr?.trim() ?? "";
  if (proc.status !== 0) {
    const combined = `${stdout}\n${stderr}`;
    if (/\bE404\b|404 Not Found|is not in this registry/i.test(combined)) {
      return { published: false, gitHead: null };
    }
    return {
      published: false,
      gitHead: null,
      error: combined.trim() || `npm view exited with status ${String(proc.status)}`,
    };
  }
  if (!stdout) {
    return { published: false, gitHead: null };
  }
  try {
    const parsed = JSON.parse(stdout) as string | { version?: string; gitHead?: string };
    if (typeof parsed === "string") {
      return { published: parsed.trim() === version, gitHead: null };
    }
    return {
      published: parsed.version === version,
      gitHead:
        typeof parsed.gitHead === "string" && SHA_RE.test(parsed.gitHead) ? parsed.gitHead : null,
    };
  } catch (error) {
    return {
      published: false,
      gitHead: null,
      error: `Failed to parse npm view JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function parseArgs(argv: string[]): {
  repository: string;
  ref: string;
  mainRef: string;
  waitSeconds: number;
  repoRoot?: string;
} {
  let repository = process.env.GITHUB_REPOSITORY ?? "";
  let ref = process.env.GITHUB_REF ?? "";
  let mainRef = "origin/main";
  let waitSeconds = 180;
  let repoRoot: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") repository = argv[++i] ?? "";
    else if (arg === "--ref") ref = argv[++i] ?? "";
    else if (arg === "--main-ref") mainRef = argv[++i] ?? "";
    else if (arg === "--repo-root") repoRoot = argv[++i] ?? "";
    else if (arg === "--wait-seconds") {
      waitSeconds = Number.parseInt(argv[++i] ?? "180", 10);
      if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
        throw new Error(`Invalid --wait-seconds: ${argv[i]}`);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    repository,
    ref,
    mainRef,
    waitSeconds,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
  };
}

export async function runVerifyReleaseTag(options: {
  repoRoot: string;
  repository: string;
  ref: string;
  mainRef: string;
  waitSeconds: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ReleaseTagQualificationResult> {
  const { repoRoot, repository, ref, mainRef, waitSeconds } = options;
  const env = options.env ?? process.env;

  const tag = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  const tagSha = tag
    ? gitOptional(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`])
    : null;
  const mainRefSha = gitOptional(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${mainRef}^{commit}`,
  ]);
  const tagOnMain =
    tagSha !== null && mainRefSha !== null && gitIsAncestor(repoRoot, tagSha, mainRefSha);

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

  const deadline = Date.now() + waitSeconds * 1000;

  while (true) {
    const npmRecord = version
      ? readNpmReleaseRecord(version, env)
      : { published: false, gitHead: null };
    const ciRuns =
      repository === CANONICAL_REPOSITORY && tagSha
        ? listWorkflowRuns(
            repoRoot,
            repository,
            "ci.yml",
            ["--commit", tagSha, "--event", "push"],
            env,
          )
        : [];
    const releaseRuns =
      repository === CANONICAL_REPOSITORY && tagSha
        ? listWorkflowRuns(repoRoot, repository, "release.yml", [], env)
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
        tagSha === null || mainRefSha === null
          ? undefined
          : (sha) =>
              gitIsAncestor(repoRoot, tagSha, sha) && gitIsAncestor(repoRoot, sha, mainRefSha),
      npmPublished: npmRecord.published,
      npmGitHead: npmRecord.gitHead,
      ...(npmRecord.error !== undefined ? { npmError: npmRecord.error } : {}),
    });

    if (result.ok) {
      return result;
    }

    if (result.waiting && Date.now() < deadline) {
      console.log(`verify-release-tag: waiting (${result.reason})`);
      await new Promise<void>((r) => setTimeout(r, 10_000));
      continue;
    }

    return result;
  }
}

if (import.meta.main) {
  const {
    repository,
    ref,
    mainRef,
    waitSeconds,
    repoRoot: cliRepoRoot,
  } = parseArgs(process.argv.slice(2));
  const repoRoot = cliRepoRoot
    ? resolve(cliRepoRoot)
    : resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  const result = await runVerifyReleaseTag({
    repoRoot,
    repository,
    ref,
    mainRef,
    waitSeconds,
  });

  if (result.ok) {
    console.log(
      `verify-release-tag: qualified ${result.tag} (${result.tagSha}) via ${result.qualificationMode}`,
    );
    process.exit(0);
  }

  console.error(`verify-release-tag: error: ${result.reason}`);
  process.exit(1);
}
