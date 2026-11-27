import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureScopedTagAtPublishedCommit,
  readNpmPackageRecord,
  resolveScopedTagTarget,
} from "../../../scripts/publish-release.js";

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

function createTempRepoWithMockNpm(npmScript: string): {
  root: string;
  worktree: string;
  env: NodeJS.ProcessEnv;
  writeVersionCommit: (version: string, message: string) => string;
} {
  const root = mkdtempSync(join(tmpdir(), "sweep-publish-release-"));
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
  writeFileSync(npmPath, `#!/bin/sh\n${npmScript}\n`);
  chmodSync(npmPath, 0o755);

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

describe("publish-release scoped tag identity", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);

  test("refuses legacy npm versions with no gitHead and prints manual recovery path", () => {
    const res = resolveScopedTagTarget({
      version: "0.5.2",
      gitTag: "@kitsunekode/sweep@0.5.2",
      npmRecord: { status: "found", version: "0.5.2", gitHead: null },
      existingScopedTagSha: null,
      npmGitHeadOnMain: false,
      npmGitHeadPackageVersion: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("no gitHead metadata");
      expect(res.reason).toContain("Manual path");
    }
  });

  test("refuses conflicting existing scoped tag or off-main npm gitHead", () => {
    const offMain = resolveScopedTagTarget({
      version: "0.5.4",
      gitTag: "@kitsunekode/sweep@0.5.4",
      npmRecord: { status: "found", version: "0.5.4", gitHead: SHA_A },
      existingScopedTagSha: null,
      npmGitHeadOnMain: false,
      npmGitHeadPackageVersion: "0.5.4",
    });
    expect(offMain.ok).toBe(false);
    if (!offMain.ok) expect(offMain.reason).toContain("ancestor of canonical main");

    const conflict = resolveScopedTagTarget({
      version: "0.5.4",
      gitTag: "@kitsunekode/sweep@0.5.4",
      npmRecord: { status: "found", version: "0.5.4", gitHead: SHA_A },
      existingScopedTagSha: SHA_B,
      npmGitHeadOnMain: true,
      npmGitHeadPackageVersion: "0.5.4",
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toContain("disagrees");
  });

  test.skipIf(process.platform === "win32")(
    "temp git repo with mocked npm: retry creates missing scoped tag at npm gitHead (never HEAD), and refuses legacy/off-main commits",
    () => {
      const repo = createTempRepoWithMockNpm(
        'printf \'{"version":"0.5.4","gitHead":"%s"}\' "$MOCK_NPM_GIT_HEAD"',
      );
      try {
        const publishedSha = repo.writeVersionCommit("0.5.4", "chore: version 0.5.4");
        // Advance main past the published commit to simulate a retry checkout.
        writeFileSync(join(repo.worktree, "README.md"), "# retry checkout ahead of release\n");
        git(repo.worktree, ["add", "README.md"]);
        git(repo.worktree, ["commit", "-m", "docs: later commit on main"]);
        const retryHeadSha = git(repo.worktree, ["rev-parse", "HEAD"]);
        expect(retryHeadSha).not.toBe(publishedSha);
        git(repo.worktree, ["push", "origin", "main"]);

        // Mock npm returns publishedSha as gitHead.
        const env = { ...repo.env, MOCK_NPM_GIT_HEAD: publishedSha };
        expect(readNpmPackageRecord("@kitsunekode/sweep", "0.5.4", env)).toEqual({
          status: "found",
          version: "0.5.4",
          gitHead: publishedSha,
        });

        // Missing scoped tag must be created at publishedSha, NOT at retryHeadSha.
        const created = ensureScopedTagAtPublishedCommit({
          repoRoot: repo.worktree,
          version: "0.5.4",
          gitTag: "@kitsunekode/sweep@0.5.4",
          mainRef: "origin/main",
          env,
        });
        expect(created).toEqual({ action: "create", targetCommit: publishedSha });
        const taggedSha = git(repo.worktree, [
          "rev-parse",
          "refs/tags/@kitsunekode/sweep@0.5.4^{commit}",
        ]);
        expect(taggedSha).toBe(publishedSha);
        expect(taggedSha).not.toBe(retryHeadSha);

        // Second call is an idempotent noop.
        const noop = ensureScopedTagAtPublishedCommit({
          repoRoot: repo.worktree,
          version: "0.5.4",
          gitTag: "@kitsunekode/sweep@0.5.4",
          mainRef: "origin/main",
          env,
        });
        expect(noop).toEqual({ action: "noop", targetCommit: publishedSha });

        // Off-main gitHead is refused even if it carries the right package version.
        git(repo.worktree, ["checkout", "-b", "side-branch", publishedSha]);
        writeFileSync(join(repo.worktree, "SIDE.md"), "off-main\n");
        git(repo.worktree, ["add", "SIDE.md"]);
        git(repo.worktree, ["commit", "-m", "chore: side commit"]);
        const sideSha = git(repo.worktree, ["rev-parse", "HEAD"]);
        git(repo.worktree, ["tag", "-d", "@kitsunekode/sweep@0.5.4"]);
        expect(() =>
          ensureScopedTagAtPublishedCommit({
            repoRoot: repo.worktree,
            version: "0.5.4",
            gitTag: "@kitsunekode/sweep@0.5.4",
            mainRef: "origin/main",
            env: { ...repo.env, MOCK_NPM_GIT_HEAD: sideSha },
          }),
        ).toThrow(/ancestor of canonical main/);

        // Legacy release with no gitHead (bare version string like 0.5.2) is refused with manual path.
        expect(() =>
          ensureScopedTagAtPublishedCommit({
            repoRoot: repo.worktree,
            version: "0.5.2",
            gitTag: "@kitsunekode/sweep@0.5.2",
            mainRef: "origin/main",
            readNpm: () => ({ status: "found", version: "0.5.2", gitHead: null }),
          }),
        ).toThrow(/Manual path/);
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    },
  );
});
