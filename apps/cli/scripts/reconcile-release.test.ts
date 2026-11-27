import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RELEASE_BINARY_TARGETS,
  expectedReleaseAssets,
  parseBinaryTargetsFromWorkflow,
  planReleaseReconciliation,
} from "./reconcile-release.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("reconcile-release", () => {
  test("parses all seven matrix targets from cli-binaries.yml", () => {
    const yaml = readFileSync(join(REPO_ROOT, ".github/workflows/cli-binaries.yml"), "utf8");
    const parsed = parseBinaryTargetsFromWorkflow(yaml);
    expect(parsed).toEqual([...DEFAULT_RELEASE_BINARY_TARGETS]);
    expect(expectedReleaseAssets(parsed)).toHaveLength(56);
  });

  test("skips when version is not published on npm and changesets did not publish", () => {
    const plan = planReleaseReconciliation({
      version: "0.5.3",
      headSha: SHA_A,
      changesetsPublished: false,
      npmPublished: false,
      npmGitHead: null,
      packageTagSha: null,
      binaryTagSha: null,
      releaseAssets: [],
    });
    expect(plan.kind).toBe("skip");
  });

  test("creates vX.Y.Z tag on the exact released commit and dispatches when npm published earlier but tag is missing", () => {
    const plan = planReleaseReconciliation({
      version: "0.5.3",
      headSha: SHA_B, // main has moved ahead of the released commit
      versionCommitSha: SHA_A,
      changesetsPublished: false,
      npmPublished: true,
      npmGitHead: SHA_A,
      packageTagSha: SHA_A,
      binaryTagSha: null,
      releaseAssets: [],
    });
    expect(plan).toMatchObject({
      kind: "reconcile",
      binaryTag: "v0.5.3",
      packageTag: "@kitsunekode/sweep@0.5.3",
      targetCommit: SHA_A,
      createBinaryTag: true,
      pushBinaryTag: true,
      dispatchWorkflow: true,
    });
  });

  test("falls back to versionCommitSha when tarball publish lacks npm gitHead and scoped tag", () => {
    const plan = planReleaseReconciliation({
      version: "0.5.3",
      headSha: SHA_B,
      versionCommitSha: SHA_A,
      changesetsPublished: false,
      npmPublished: true,
      npmGitHead: null,
      packageTagSha: null,
      binaryTagSha: null,
      releaseAssets: [],
    });
    expect(plan).toMatchObject({
      kind: "reconcile",
      targetCommit: SHA_A,
      createBinaryTag: true,
      pushBinaryTag: true,
      dispatchWorkflow: true,
    });
  });

  test("dispatches cli-binaries.yml without recreating tag when vX.Y.Z matches commit but binaries are missing", () => {
    const expected = expectedReleaseAssets(["linux-x64", "win-x64"]);
    const plan = planReleaseReconciliation({
      version: "0.5.3",
      headSha: SHA_A,
      versionCommitSha: SHA_A,
      changesetsPublished: false,
      npmPublished: true,
      npmGitHead: SHA_A,
      packageTagSha: SHA_A,
      binaryTagSha: SHA_A,
      releaseAssets: expected.slice(0, 2),
      expectedAssets: expected,
    });
    expect(plan).toMatchObject({
      kind: "reconcile",
      targetCommit: SHA_A,
      createBinaryTag: false,
      pushBinaryTag: false,
      dispatchWorkflow: true,
      missingAssets: expected.slice(2),
    });
  });

  test("no-ops when npm, binary tag, and all expected release assets are already complete", () => {
    const expected = expectedReleaseAssets(["linux-x64", "win-x64"]);
    const plan = planReleaseReconciliation({
      version: "0.5.2",
      headSha: SHA_B,
      versionCommitSha: SHA_A,
      changesetsPublished: false,
      npmPublished: true,
      npmGitHead: null,
      packageTagSha: null,
      binaryTagSha: SHA_A,
      releaseAssets: expected,
      expectedAssets: expected,
    });
    expect(plan.kind).toBe("noop");
  });

  test("refuses to move an existing vX.Y.Z tag pointing to a different commit", () => {
    const plan = planReleaseReconciliation({
      version: "0.5.3",
      headSha: SHA_A,
      versionCommitSha: SHA_A,
      changesetsPublished: false,
      npmPublished: true,
      npmGitHead: SHA_A,
      packageTagSha: SHA_A,
      binaryTagSha: SHA_B,
      releaseAssets: [],
    });
    expect(plan.kind).toBe("error");
    if (plan.kind === "error") {
      expect(plan.reason).toContain("refusing to move tag");
    }
  });

  test("refuses when package tag disagrees with npm gitHead or freshly published HEAD", () => {
    const npmMismatch = planReleaseReconciliation({
      version: "0.5.3",
      headSha: SHA_A,
      changesetsPublished: false,
      npmPublished: true,
      npmGitHead: SHA_B,
      packageTagSha: SHA_A,
      binaryTagSha: null,
      releaseAssets: [],
    });
    expect(npmMismatch.kind).toBe("error");

    const freshMismatch = planReleaseReconciliation({
      version: "0.5.3",
      headSha: SHA_B,
      changesetsPublished: true,
      npmPublished: true,
      npmGitHead: SHA_A,
      packageTagSha: SHA_A,
      binaryTagSha: null,
      releaseAssets: [],
    });
    expect(freshMismatch.kind).toBe("error");
  });
});
