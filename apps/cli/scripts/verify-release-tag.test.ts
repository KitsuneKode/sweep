import { describe, expect, test } from "bun:test";
import {
  CANONICAL_REPOSITORY,
  evaluateReleaseTagQualification,
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

describe("verify-release-tag", () => {
  test("qualifies a tag on canonical main with matching package version, push CI, and release workflow", () => {
    const result = evaluateReleaseTagQualification({
      repository: CANONICAL_REPOSITORY,
      ref: "refs/tags/v0.5.4",
      tagSha: SHA_A,
      tagOnMain: true,
      packageVersionAtTag: "0.5.4",
      packageTagSha: SHA_A,
      ciRuns: [ciPass(SHA_A)],
      releaseRuns: [releasePass(SHA_A)],
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
    });
    expect(waiting.ok).toBe(false);
    if (!waiting.ok) {
      expect(waiting.waiting).toBe(true);
    }
  });

  test("qualifies a reconciled release when a descendant main commit passed release.yml with durable npm evidence", () => {
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
      npmGitHead: null,
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
});
