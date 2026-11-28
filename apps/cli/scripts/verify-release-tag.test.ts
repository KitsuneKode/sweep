import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANONICAL_REPOSITORY,
  evaluateReleaseTagQualification,
  runVerifyReleaseTag,
  type WorkflowRunRecord,
} from "./verify-release-tag.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function ciPass(sha: string): WorkflowRunRecord {
  return {
    databaseId: 100,
    headSha: sha,
    headBranch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
  };
}

function releasePass(sha: string, event = "push"): WorkflowRunRecord {
  return {
    databaseId: 200,
    headSha: sha,
    headBranch: "main",
    event,
    status: "completed",
    conclusion: "success",
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

function createTempRepoWithMocks(options: { npmScript: string; ghScript: string }): {
  root: string;
  worktree: string;
  env: NodeJS.ProcessEnv;
  writeVersionCommit: (version: string, message: string) => string;
} {
  const root = mkdtempSync(join(tmpdir(), "sweep-verify-tag-"));
  const bareRemote = join(root, "remote.git");
  const worktree = join(root, "work");
  const binDir = join(root, "bin");
  mkdirSync(bareRemote, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  git(bareRemote, ["init", "--bare", "--initial-branch=main"]);
  git(worktree, ["init", "--initial-branch=main"]);
  git(worktree, ["remote", "add", "origin", bareRemote]);
  mkdirSync(join(worktree, "apps/cli"), { recursive: true });

  const npmPath = join(binDir, "npm");
  const ghPath = join(binDir, "gh");
  writeFileSync(npmPath, `#!/bin/sh\n${options.npmScript}\n`);
  writeFileSync(ghPath, `#!/bin/sh\n${options.ghScript}\n`);
  chmodSync(npmPath, 0o755);
  chmodSync(ghPath, 0o755);

  const writeVersionCommit = (version: string, message: string): string => {
    writeFileSync(
      join(worktree, "apps/cli/package.json"),
      `${JSON.stringify({ name: "@kitsunekode/sweep", version }, null, 2)}\n`,
    );
    git(worktree, ["add", "."]);
    git(worktree, ["commit", "-m", message]);
    return git(worktree, ["rev-parse", "HEAD"]);
  };

  return {
    root,
    worktree,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    writeVersionCommit,
  };
}

describe("verify-release-tag", () => {
  test("qualifies a tag on canonical main with matching npm gitHead, package version, push CI, and release workflow", () => {
    const result = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/tags/v0.5.4",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.4",
      packageTagSha: SHA_A,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [releasePass(SHA_A)],
      npmPublished: true,
      npmGitHead: SHA_A,
    });
    expect(result).toEqual({
      ok: true,
      version: "0.5.4",
      tag: "v0.5.4",
      tagSha: SHA_A,
      prerelease: false,
      qualificationMode: "direct-release",
    });
  });

  test("rejects direct release match when npm package is not published or npm gitHead disagrees", () => {
    const unpublished = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/tags/v0.5.4",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.4",
      packageTagSha: SHA_A,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [releasePass(SHA_A)],
      npmPublished: false,
      npmGitHead: null,
    });
    expect(unpublished.ok).toBe(false);
    if (!unpublished.ok) expect(unpublished.reason).toContain("not published on npm");

    const mismatchedGitHead = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/tags/v0.5.4",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.4",
      packageTagSha: SHA_A,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [releasePass(SHA_A)],
      npmPublished: true,
      npmGitHead: SHA_B,
    });
    expect(mismatchedGitHead.ok).toBe(false);
    if (!mismatchedGitHead.ok) expect(mismatchedGitHead.reason).toContain("does not match");
  });

  test("refuses legacy versions with no npm gitHead and prints the manual path on both direct and reconciled routes", () => {
    const legacyDirect = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/tags/v0.5.2",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.2",
      packageTagSha: SHA_A,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [releasePass(SHA_A)],
      npmPublished: true,
      npmGitHead: null,
    });
    expect(legacyDirect.ok).toBe(false);
    if (!legacyDirect.ok) {
      expect(legacyDirect.reason).toContain("no gitHead metadata");
      expect(legacyDirect.reason).toContain("Manual path");
    }

    const legacyReconciled = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/tags/v0.5.2",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.2",
      packageTagSha: SHA_A,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [releasePass(SHA_B, "workflow_dispatch")],
      releaseRunShaIsDescendantOfTag: (sha) => sha === SHA_B,
      npmPublished: true,
      npmGitHead: null,
    });
    expect(legacyReconciled.ok).toBe(false);
    if (!legacyReconciled.ok) {
      expect(legacyReconciled.reason).toContain("no gitHead metadata");
      expect(legacyReconciled.reason).toContain("Manual path");
    }
  });

  test("rejects forks and non-v* tag refs", () => {
    const fork = evaluateReleaseTagQualification({
      repository: "someone-else/sweep",
      ref: "refs/tags/v0.5.4",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.4",
      packageTagSha: SHA_A,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [releasePass(SHA_A)],
      npmPublished: true,
      npmGitHead: SHA_A,
    });
    expect(fork.ok).toBe(false);

    const branchRef = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/heads/main",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.4",
      packageTagSha: SHA_A,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [releasePass(SHA_A)],
      npmPublished: true,
      npmGitHead: SHA_A,
    });
    expect(branchRef.ok).toBe(false);
  });

  test("rejects tags not on main, mismatched package version, or mismatched scoped tag", () => {
    const offMain = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/tags/v0.5.4",
      tagSha: SHA_A,
      tagOnMain: false,
      packageVersionAtTag: "0.5.4",
      packageTagSha: SHA_A,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [releasePass(SHA_A)],
      npmPublished: true,
      npmGitHead: SHA_A,
    });
    expect(offMain.ok).toBe(false);
    if (!offMain.ok) expect(offMain.reason).toContain("canonical main");

    const wrongVersion = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/tags/v0.5.4",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.3",
      packageTagSha: SHA_A,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [releasePass(SHA_A)],
      npmPublished: true,
      npmGitHead: SHA_A,
    });
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.reason).toContain("0.5.3");

    const wrongScopedTag = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/tags/v0.5.4",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.4",
      packageTagSha: SHA_B,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [releasePass(SHA_A)],
      npmPublished: true,
      npmGitHead: SHA_A,
    });
    expect(wrongScopedTag.ok).toBe(false);
    if (!wrongScopedTag.ok) expect(wrongScopedTag.reason).toContain("disagrees");
  });

  test("rejects when push CI failed or release workflow never succeeded", () => {
    const failedCi = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/tags/v0.5.4",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.4",
      packageTagSha: SHA_A,
      ciRuns: [{ ...ciPass(SHA_A), conclusion: "failure" }],
      releaseRuns: [releasePass(SHA_A)],
      npmPublished: true,
      npmGitHead: SHA_A,
    });
    expect(failedCi.ok).toBe(false);

    const noRelease = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/tags/v0.5.4",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.4",
      packageTagSha: SHA_A,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [],
      npmPublished: true,
      npmGitHead: SHA_A,
    });
    expect(noRelease.ok).toBe(false);
  });

  test("marks in-progress release workflow on main as waiting rather than permanent failure", () => {
    const waiting = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/tags/v0.5.4",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.4",
      packageTagSha: SHA_A,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [
        {
          databaseId: 300,
          headSha: SHA_A,
          headBranch: "main",
          event: "push",
          status: "in_progress",
          conclusion: null,
        },
      ],
      npmPublished: true,
      npmGitHead: SHA_A,
    });
    expect(waiting.ok).toBe(false);
    if (!waiting.ok) {
      expect(waiting.waiting).toBe(true);
    }
  });

  test("qualifies a reconciled release when a descendant main commit passed release.yml with matching npm gitHead", () => {
    const reconciled = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/tags/v0.5.4",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.4",
      packageTagSha: SHA_A,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [releasePass(SHA_B, "workflow_dispatch")],
      releaseRunShaIsDescendantOfTag: (sha) => sha === SHA_B,
      npmPublished: true,
      npmGitHead: SHA_A,
    });
    expect(reconciled).toEqual({
      ok: true,
      version: "0.5.4",
      tag: "v0.5.4",
      tagSha: SHA_A,
      prerelease: false,
      qualificationMode: "reconciled-release",
    });
  });

  test.skipIf(process.platform === "win32")(
    "temp git repo with mocked npm/gh: qualifies matching gitHead and rejects missing/mismatched gitHead",
    async () => {
      const first = createTempRepoWithMocks({
        npmScript: 'printf \'{"version":"0.5.4","gitHead":"%s"}\' "$MOCK_NPM_GIT_HEAD"',
        ghScript: `
case "$*" in
  *"--workflow ci.yml"*)
    printf '[{"databaseId":101,"headSha":"%s","headBranch":"main","event":"push","status":"completed","conclusion":"success"}]' "$MOCK_TAG_SHA"
    ;;
  *"--workflow release.yml"*)
    printf '[{"databaseId":202,"headSha":"%s","headBranch":"main","event":"push","status":"completed","conclusion":"success"}]' "$MOCK_RELEASE_SHA"
    ;;
  *)
    exit 1
    ;;
esac
`,
      });
      try {
        const releaseSha = first.writeVersionCommit("0.5.4", "chore: version packages");
        git(first.worktree, ["tag", "@kitsunekode/sweep@0.5.4", releaseSha]);
        git(first.worktree, ["tag", "v0.5.4", releaseSha]);
        writeFileSync(join(first.worktree, "README.md"), "# follow-up\n");
        git(first.worktree, ["add", "README.md"]);
        git(first.worktree, ["commit", "-m", "docs: follow-up"]);
        const headSha = git(first.worktree, ["rev-parse", "HEAD"]);
        git(first.worktree, ["push", "origin", "main", "--tags"]);

        // 1. Direct match with matching npm gitHead qualifies.
        const directOk = await runVerifyReleaseTag({
          repoRoot: first.worktree,
          repository: CANONICAL_REPOSITORY,
          ref: "refs/tags/v0.5.4",
          mainRef: "origin/main",
          waitSeconds: 0,
          env: {
            ...first.env,
            MOCK_NPM_GIT_HEAD: releaseSha,
            MOCK_TAG_SHA: releaseSha,
            MOCK_RELEASE_SHA: releaseSha,
          },
        });
        expect(directOk).toEqual({
          ok: true,
          version: "0.5.4",
          tag: "v0.5.4",
          tagSha: releaseSha,
          prerelease: false,
          qualificationMode: "direct-release",
        });

        // 2. Direct release.yml pass with mismatched npm gitHead is refused.
        const wrongHead = await runVerifyReleaseTag({
          repoRoot: first.worktree,
          repository: CANONICAL_REPOSITORY,
          ref: "refs/tags/v0.5.4",
          mainRef: "origin/main",
          waitSeconds: 0,
          env: {
            ...first.env,
            MOCK_NPM_GIT_HEAD: headSha,
            MOCK_TAG_SHA: releaseSha,
            MOCK_RELEASE_SHA: releaseSha,
          },
        });
        expect(wrongHead.ok).toBe(false);
        if (!wrongHead.ok) expect(wrongHead.reason).toContain("does not match");

        // 3. Reconciled release on descendant main commit with matching npm gitHead qualifies.
        const reconciledOk = await runVerifyReleaseTag({
          repoRoot: first.worktree,
          repository: CANONICAL_REPOSITORY,
          ref: "refs/tags/v0.5.4",
          mainRef: "origin/main",
          waitSeconds: 0,
          env: {
            ...first.env,
            MOCK_NPM_GIT_HEAD: releaseSha,
            MOCK_TAG_SHA: releaseSha,
            MOCK_RELEASE_SHA: headSha,
          },
        });
        expect(reconciledOk).toEqual({
          ok: true,
          version: "0.5.4",
          tag: "v0.5.4",
          tagSha: releaseSha,
          prerelease: false,
          qualificationMode: "reconciled-release",
        });

        // 4. Legacy release with no gitHead (npm returns bare version string like 0.5.2) is refused.
        const legacy = createTempRepoWithMocks({
          npmScript: "printf '\"0.5.2\"'",
          ghScript: `
case "$*" in
  *"--workflow ci.yml"*)
    printf '[{"databaseId":101,"headSha":"%s","headBranch":"main","event":"push","status":"completed","conclusion":"success"}]' "$MOCK_TAG_SHA"
    ;;
  *"--workflow release.yml"*)
    printf '[{"databaseId":202,"headSha":"%s","headBranch":"main","event":"push","status":"completed","conclusion":"success"}]' "$MOCK_TAG_SHA"
    ;;
  *)
    exit 1
    ;;
esac
`,
        });
        try {
          const sha052 = legacy.writeVersionCommit("0.5.2", "chore: version 0.5.2");
          git(legacy.worktree, ["tag", "@kitsunekode/sweep@0.5.2", sha052]);
          git(legacy.worktree, ["tag", "v0.5.2", sha052]);
          git(legacy.worktree, ["push", "origin", "main", "--tags"]);

          const legacyRes = await runVerifyReleaseTag({
            repoRoot: legacy.worktree,
            repository: CANONICAL_REPOSITORY,
            ref: "refs/tags/v0.5.2",
            mainRef: "origin/main",
            waitSeconds: 0,
            env: { ...legacy.env, MOCK_TAG_SHA: sha052 },
          });
          expect(legacyRes.ok).toBe(false);
          if (!legacyRes.ok) {
            expect(legacyRes.reason).toContain("no gitHead metadata");
            expect(legacyRes.reason).toContain("Manual path");
          }
        } finally {
          rmSync(legacy.root, { recursive: true, force: true });
        }
      } finally {
        rmSync(first.root, { recursive: true, force: true });
      }
    },
  );
});
