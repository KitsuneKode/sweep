import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_REF,
  CANONICAL_REPOSITORY,
  DEFAULT_RELEASE_BINARY_TARGETS,
  expectedReleaseAssets,
  parseBinaryTargetsFromWorkflow,
  planReleaseReconciliation,
  runReconcileRelease,
  type DownstreamTarget,
  type ReleaseClients,
} from "./reconcile-release.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const BASE_INPUT = {
  repository: CANONICAL_REPOSITORY,
  ref: CANONICAL_REF,
  version: "0.5.4",
  headSha: SHA_A,
  changesetsPublished: false,
  npm: { status: "found" as const, gitHead: SHA_A },
  packageTagSha: SHA_A,
  binaryTagSha: null as string | null,
  targetCommitOnMain: true,
  targetCommitPackageVersion: "0.5.4",
  releaseAssets: { status: "not_found" as const },
  activeBinaryRuns: { status: "ok" as const, runs: [] },
  homebrew: { status: "found" as const, version: "0.5.3" },
  scoop: { status: "found" as const, version: "0.5.3" },
};

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

function createTempReleaseRepo(): {
  root: string;
  bareRemote: string;
  worktree: string;
  writeVersionCommit: (version: string, message: string) => string;
} {
  const root = mkdtempSync(join(tmpdir(), "sweep-reconcile-repo-"));
  const bareRemote = join(root, "remote.git");
  const worktree = join(root, "work");
  mkdirSync(bareRemote, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  git(bareRemote, ["init", "--bare", "--initial-branch=main"]);
  git(worktree, ["init", "--initial-branch=main"]);
  git(worktree, ["remote", "add", "origin", bareRemote]);
  mkdirSync(join(worktree, "apps/cli"), { recursive: true });
  mkdirSync(join(worktree, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(worktree, ".github/workflows/cli-binaries.yml"),
    "        include:\n          - id: linux-x64\n          - id: win-x64\n",
  );

  const writeVersionCommit = (version: string, message: string): string => {
    writeFileSync(
      join(worktree, "apps/cli/package.json"),
      `${JSON.stringify({ name: "@kitsunekode/sweep", version }, null, 2)}\n`,
    );
    git(worktree, ["add", "."]);
    git(worktree, ["commit", "-m", message]);
    return git(worktree, ["rev-parse", "HEAD"]);
  };

  return { root, bareRemote, worktree, writeVersionCommit };
}

describe("reconcile-release", () => {
  test("parses all seven matrix targets from cli-binaries.yml", () => {
    const yaml = readFileSync(join(REPO_ROOT, ".github/workflows/cli-binaries.yml"), "utf8");
    const parsed = parseBinaryTargetsFromWorkflow(yaml);
    expect(parsed).toEqual([...DEFAULT_RELEASE_BINARY_TARGETS]);
    expect(expectedReleaseAssets(parsed)).toHaveLength(56);
  });

  test("refuses non-canonical repository or non-main ref", () => {
    const fork = planReleaseReconciliation({ ...BASE_INPUT, repository: "fork/sweep" });
    expect(fork.kind).toBe("error");
    if (fork.kind === "error") expect(fork.reason).toContain(CANONICAL_REPOSITORY);

    const branch = planReleaseReconciliation({ ...BASE_INPUT, ref: "refs/heads/feature" });
    expect(branch.kind).toBe("error");
    if (branch.kind === "error") expect(branch.reason).toContain(CANONICAL_REF);
  });

  test("skips when version is not published on npm and changesets did not publish", () => {
    const plan = planReleaseReconciliation({
      ...BASE_INPUT,
      npm: { status: "not_found" },
      packageTagSha: null,
    });
    expect(plan.kind).toBe("skip");
  });

  test("creates vX.Y.Z tag on the exact released commit and dispatches when npm published earlier", () => {
    const plan = planReleaseReconciliation({
      ...BASE_INPUT,
      headSha: SHA_B, // main moved ahead of the released commit
    });
    expect(plan).toMatchObject({
      kind: "reconcile",
      binaryTag: "v0.5.4",
      packageTag: "@kitsunekode/sweep@0.5.4",
      targetCommit: SHA_A,
      createBinaryTag: true,
      pushBinaryTag: true,
      dispatchWorkflow: true,
      dispatchTarget: "all",
      dispatchDownstream: "all",
    });
  });

  test("refuses reconciliation when both npm gitHead and scoped package tag are absent", () => {
    const plan = planReleaseReconciliation({
      ...BASE_INPUT,
      headSha: SHA_B,
      npm: { status: "found", gitHead: null },
      packageTagSha: null,
      binaryTagSha: null,
    });
    expect(plan.kind).toBe("error");
    if (plan.kind === "error") {
      expect(plan.reason).toContain("missing authoritative publication commit");
    }
  });

  test("refuses when authoritative commit is not on canonical main or carries wrong version", () => {
    const offMain = planReleaseReconciliation({
      ...BASE_INPUT,
      targetCommitOnMain: false,
    });
    expect(offMain.kind).toBe("error");
    if (offMain.kind === "error") expect(offMain.reason).toContain("canonical main");

    const wrongPkg = planReleaseReconciliation({
      ...BASE_INPUT,
      targetCommitPackageVersion: "0.5.3",
    });
    expect(wrongPkg.kind).toBe("error");
    if (wrongPkg.kind === "error") expect(wrongPkg.reason).toContain("0.5.3");
  });

  test("deduplicates queued or in-progress cli-binaries.yml runs for the same tag and commit", () => {
    const expected = expectedReleaseAssets(["linux-x64", "win-x64"]);
    for (const status of ["queued", "in_progress"]) {
      const plan = planReleaseReconciliation({
        ...BASE_INPUT,
        binaryTagSha: SHA_A,
        releaseAssets: { status: "found", assets: expected.slice(0, 2) },
        expectedAssets: expected,
        activeBinaryRuns: {
          status: "ok",
          runs: [{ databaseId: 4242, status, headBranch: "v0.5.4", headSha: SHA_A }],
        },
      });
      expect(plan).toMatchObject({
        kind: "noop",
        activeRunId: 4242,
      });
    }
  });

  test("distinguishes GitHub API errors from 404 on release, active runs, and downstream lookups", () => {
    const releaseErr = planReleaseReconciliation({
      ...BASE_INPUT,
      releaseAssets: { status: "error", error: "HTTP 502 Bad Gateway" },
    });
    expect(releaseErr.kind).toBe("error");
    if (releaseErr.kind === "error") expect(releaseErr.reason).toContain("502");

    const runsErr = planReleaseReconciliation({
      ...BASE_INPUT,
      activeBinaryRuns: { status: "error", error: "rate limit exceeded" },
    });
    expect(runsErr.kind).toBe("error");

    const hbErr = planReleaseReconciliation({
      ...BASE_INPUT,
      homebrew: { status: "error", error: "HTTP 500" },
    });
    expect(hbErr.kind).toBe("error");
  });

  test("tracks Homebrew and Scoop separately and dispatches downstream-only retries without downgrading", () => {
    const expected = expectedReleaseAssets(["linux-x64", "win-x64"]);
    const baseComplete = {
      ...BASE_INPUT,
      binaryTagSha: SHA_A,
      releaseAssets: { status: "found" as const, assets: expected },
      expectedAssets: expected,
    };

    const onlyHomebrewBehind = planReleaseReconciliation({
      ...baseComplete,
      homebrew: { status: "found", version: "0.5.3" },
      scoop: { status: "found", version: "0.5.4" },
    });
    expect(onlyHomebrewBehind).toMatchObject({
      kind: "reconcile",
      createBinaryTag: false,
      dispatchWorkflow: true,
      dispatchTarget: "downstream",
      dispatchDownstream: "homebrew",
      homebrewNeedsUpdate: true,
      scoopNeedsUpdate: false,
    });

    const onlyScoopMissing = planReleaseReconciliation({
      ...baseComplete,
      homebrew: { status: "found", version: "0.5.4" },
      scoop: { status: "not_found" },
    });
    expect(onlyScoopMissing).toMatchObject({
      kind: "reconcile",
      createBinaryTag: false,
      dispatchWorkflow: true,
      dispatchTarget: "downstream",
      dispatchDownstream: "scoop",
      homebrewNeedsUpdate: false,
      scoopNeedsUpdate: true,
    });

    // Downstream already on a newer release must never downgrade.
    const newerDownstream = planReleaseReconciliation({
      ...baseComplete,
      homebrew: { status: "found", version: "0.5.5" },
      scoop: { status: "found", version: "0.6.0" },
    });
    expect(newerDownstream.kind).toBe("noop");
  });

  test("refuses to move a mismatched existing vX.Y.Z tag or disagreeing package tag / npm gitHead", () => {
    const movedTag = planReleaseReconciliation({
      ...BASE_INPUT,
      binaryTagSha: SHA_B,
    });
    expect(movedTag.kind).toBe("error");
    if (movedTag.kind === "error") expect(movedTag.reason).toContain("refusing to move tag");

    const npmMismatch = planReleaseReconciliation({
      ...BASE_INPUT,
      npm: { status: "found", gitHead: SHA_B },
      packageTagSha: SHA_A,
    });
    expect(npmMismatch.kind).toBe("error");
  });

  test("temp git repo: recovers missing vX.Y.Z tag on exact scoped-tag commit and pushes to remote", () => {
    const repo = createTempReleaseRepo();
    try {
      const releaseSha = repo.writeVersionCommit("0.5.4", "chore: version packages");
      git(repo.worktree, ["tag", "@kitsunekode/sweep@0.5.4", releaseSha]);
      // main advances with a follow-up commit while still at 0.5.4
      writeFileSync(join(repo.worktree, "README.md"), "# follow-up\n");
      git(repo.worktree, ["add", "README.md"]);
      git(repo.worktree, ["commit", "-m", "docs: follow-up"]);
      git(repo.worktree, ["push", "origin", "main", "--tags"]);

      const binaryDispatches: Array<{ repository: string; binaryTag: string }> = [];

      const clients: ReleaseClients = {
        readNpmRelease: () => ({ status: "found", gitHead: null }),
        readGitHubReleaseAssets: () => ({ status: "not_found" }),
        listActiveBinaryRuns: () => ({ status: "ok", runs: [] }),
        listActiveDownstreamRuns: () => ({ status: "ok", runs: [] }),
        readHomebrewVersion: () => ({ status: "found", version: "0.5.3" }),
        readScoopVersion: () => ({ status: "not_found" }),
        dispatchCliBinaries: (repository, binaryTag) => {
          binaryDispatches.push({ repository, binaryTag });
        },
        dispatchDownstreamRelease: () => {
          throw new Error("should not dispatch downstream directly when binaries are missing");
        },
      };

      const plan = runReconcileRelease(
        {
          repoRoot: repo.worktree,
          repository: CANONICAL_REPOSITORY,
          ref: CANONICAL_REF,
          changesetsPublished: false,
          dryRun: false,
        },
        clients,
      );

      expect(plan).toMatchObject({
        kind: "reconcile",
        binaryTag: "v0.5.4",
        targetCommit: releaseSha,
        createBinaryTag: true,
        pushBinaryTag: true,
        dispatchTarget: "all",
        dispatchDownstream: "all",
      });
      // Tag was pushed to the bare remote on the exact released commit (not HEAD).
      const remoteTagSha = git(repo.bareRemote, ["rev-parse", "refs/tags/v0.5.4^{commit}"]);
      expect(remoteTagSha).toBe(releaseSha);
      expect(binaryDispatches).toEqual([
        {
          repository: CANONICAL_REPOSITORY,
          binaryTag: "v0.5.4",
        },
      ]);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("temp git repo: retries Scoop downstream update via release-downstream.yml when binaries and Homebrew are complete", () => {
    const repo = createTempReleaseRepo();
    try {
      const releaseSha = repo.writeVersionCommit("0.5.4", "chore: version packages");
      git(repo.worktree, ["tag", "@kitsunekode/sweep@0.5.4", releaseSha]);
      git(repo.worktree, ["tag", "v0.5.4", releaseSha]);
      git(repo.worktree, ["push", "origin", "main", "--tags"]);

      const expected = expectedReleaseAssets(["linux-x64", "win-x64"]);
      const downstreamDispatches: Array<{
        repository: string;
        binaryTag: string;
        downstream: DownstreamTarget;
      }> = [];

      const clients: ReleaseClients = {
        readNpmRelease: () => ({ status: "found", gitHead: releaseSha }),
        readGitHubReleaseAssets: () => ({ status: "found", assets: expected }),
        listActiveBinaryRuns: () => ({ status: "ok", runs: [] }),
        listActiveDownstreamRuns: () => ({ status: "ok", runs: [] }),
        readHomebrewVersion: () => ({ status: "found", version: "0.5.4" }),
        readScoopVersion: () => ({ status: "found", version: "0.5.3" }),
        dispatchCliBinaries: () => {
          throw new Error("should not dispatch cli-binaries when only downstream needs retry");
        },
        dispatchDownstreamRelease: (repository, binaryTag, downstream) => {
          downstreamDispatches.push({ repository, binaryTag, downstream });
        },
      };

      const plan = runReconcileRelease(
        {
          repoRoot: repo.worktree,
          repository: CANONICAL_REPOSITORY,
          ref: CANONICAL_REF,
          changesetsPublished: false,
          dryRun: false,
        },
        clients,
      );

      expect(plan).toMatchObject({
        kind: "reconcile",
        createBinaryTag: false,
        dispatchTarget: "downstream",
        dispatchDownstream: "scoop",
      });
      expect(downstreamDispatches).toEqual([
        {
          repository: CANONICAL_REPOSITORY,
          binaryTag: "v0.5.4",
          downstream: "scoop",
        },
      ]);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("temp git repo: refuses commit not on canonical main", () => {
    const repo = createTempReleaseRepo();
    try {
      repo.writeVersionCommit("0.5.3", "chore: 0.5.3");
      git(repo.worktree, ["push", "origin", "main"]);
      git(repo.worktree, ["checkout", "-b", "side-branch"]);
      const sideSha = repo.writeVersionCommit("0.5.4", "chore: off-main 0.5.4");
      git(repo.worktree, ["tag", "@kitsunekode/sweep@0.5.4", sideSha]);

      const clients: ReleaseClients = {
        readNpmRelease: () => ({ status: "found", gitHead: sideSha }),
        readGitHubReleaseAssets: () => ({ status: "not_found" }),
        listActiveBinaryRuns: () => ({ status: "ok", runs: [] }),
        listActiveDownstreamRuns: () => ({ status: "ok", runs: [] }),
        readHomebrewVersion: () => ({ status: "found", version: "0.5.3" }),
        readScoopVersion: () => ({ status: "found", version: "0.5.3" }),
        dispatchCliBinaries: () => {
          throw new Error("should not dispatch");
        },
        dispatchDownstreamRelease: () => {
          throw new Error("should not dispatch");
        },
      };

      const plan = runReconcileRelease(
        {
          repoRoot: repo.worktree,
          repository: CANONICAL_REPOSITORY,
          ref: CANONICAL_REF,
          changesetsPublished: false,
          dryRun: false,
        },
        clients,
      );

      expect(plan.kind).toBe("error");
      if (plan.kind === "error") {
        expect(plan.reason).toContain("canonical main");
      }
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("temp git repo: fails closed when origin/main does not resolve instead of falling back to HEAD", () => {
    const repo = createTempReleaseRepo();
    try {
      const releaseSha = repo.writeVersionCommit("0.5.4", "chore: version packages");
      git(repo.worktree, ["tag", "@kitsunekode/sweep@0.5.4", releaseSha]);
      // Deliberately do NOT push to origin, so refs/remotes/origin/main does not exist.

      const clients: ReleaseClients = {
        readNpmRelease: () => ({ status: "found", gitHead: releaseSha }),
        readGitHubReleaseAssets: () => ({ status: "not_found" }),
        listActiveBinaryRuns: () => ({ status: "ok", runs: [] }),
        listActiveDownstreamRuns: () => ({ status: "ok", runs: [] }),
        readHomebrewVersion: () => ({ status: "found", version: "0.5.3" }),
        readScoopVersion: () => ({ status: "found", version: "0.5.3" }),
        dispatchCliBinaries: () => {
          throw new Error("should not dispatch when origin/main is missing");
        },
        dispatchDownstreamRelease: () => {
          throw new Error("should not dispatch when origin/main is missing");
        },
      };

      const plan = runReconcileRelease(
        {
          repoRoot: repo.worktree,
          repository: CANONICAL_REPOSITORY,
          ref: CANONICAL_REF,
          changesetsPublished: false,
          dryRun: false,
        },
        clients,
      );

      expect(plan.kind).toBe("error");
      if (plan.kind === "error") {
        expect(plan.reason).toContain("origin/main");
      }
      // Must not have created the v0.5.4 tag.
      expect(() => git(repo.worktree, ["rev-parse", "--verify", "refs/tags/v0.5.4"])).toThrow();
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  test("deduplicates active release-downstream.yml runs on main", () => {
    const expected = expectedReleaseAssets(["linux-x64", "win-x64"]);
    const plan = planReleaseReconciliation({
      ...BASE_INPUT,
      binaryTagSha: SHA_A,
      releaseAssets: { status: "found", assets: expected },
      expectedAssets: expected,
      homebrew: { status: "found", version: "0.5.3" },
      scoop: { status: "found", version: "0.5.4" },
      activeDownstreamRuns: {
        status: "ok",
        runs: [{ databaseId: 9001, status: "in_progress", headBranch: "main", headSha: SHA_A }],
      },
    });
    expect(plan).toMatchObject({
      kind: "noop",
      activeRunId: 9001,
    });
  });
});
