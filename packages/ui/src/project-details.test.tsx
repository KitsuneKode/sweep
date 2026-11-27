import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { gitBranch } from "./project-details.js";
import { ProjectDetails } from "./ProjectDetails.js";
import { buildProjects } from "./projects.js";
import { darkTheme } from "./theme.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sweep-project-details-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("gitBranch hardening", () => {
  test("reads a normal .git/HEAD branch and detached HEAD", () => {
    const repo = join(root, "normal");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/clean\n");
    expect(gitBranch(repo)).toBe("feat/clean");

    writeFileSync(join(repo, ".git", "HEAD"), "abcdef1234567890abcdef1234567890abcdef12\n");
    expect(gitBranch(repo)).toBe("detached abcdef1");
  });

  test("supports relative and absolute gitdir pointer files", () => {
    const absGitDir = join(root, "main-repo", ".git", "worktrees", "wt-abs");
    const wtAbs = join(root, "wt-abs");
    mkdirSync(absGitDir, { recursive: true });
    mkdirSync(wtAbs, { recursive: true });
    writeFileSync(join(absGitDir, "HEAD"), "ref: refs/heads/abs-branch\n");
    writeFileSync(join(wtAbs, ".git"), `gitdir: ${absGitDir}\n`);
    expect(gitBranch(wtAbs)).toBe("abs-branch");

    const relGitDir = join(root, "rel-gitdir");
    const wtRel = join(root, "wt-rel");
    mkdirSync(relGitDir, { recursive: true });
    mkdirSync(wtRel, { recursive: true });
    writeFileSync(join(relGitDir, "HEAD"), "ref: refs/heads/rel-branch\n");
    writeFileSync(join(wtRel, ".git"), "gitdir: ../rel-gitdir\n");
    expect(gitBranch(wtRel)).toBe("rel-branch");
  });

  test("does not follow symlinks for .git or .git/HEAD", () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "ref: refs/heads/leaked-secret\n");

    const symHead = join(root, "sym-head");
    mkdirSync(join(symHead, ".git"), { recursive: true });
    symlinkSync(secret, join(symHead, ".git", "HEAD"));
    expect(gitBranch(symHead)).toBeNull();

    const realGitDir = join(root, "real-git");
    mkdirSync(realGitDir, { recursive: true });
    writeFileSync(join(realGitDir, "HEAD"), "ref: refs/heads/target\n");

    const symDotGit = join(root, "sym-dotgit");
    mkdirSync(symDotGit, { recursive: true });
    symlinkSync(realGitDir, join(symDotGit, ".git"));
    expect(gitBranch(symDotGit)).toBeNull();
  });

  test("rejects oversized .git pointer or .git/HEAD files", () => {
    const bigHead = join(root, "big-head");
    mkdirSync(join(bigHead, ".git"), { recursive: true });
    writeFileSync(join(bigHead, ".git", "HEAD"), `ref: refs/heads/${"a".repeat(8192)}\n`);
    expect(gitBranch(bigHead)).toBeNull();

    const bigPointer = join(root, "big-pointer");
    mkdirSync(bigPointer, { recursive: true });
    writeFileSync(join(bigPointer, ".git"), `gitdir: ${"b".repeat(8192)}\n`);
    expect(gitBranch(bigPointer)).toBeNull();
  });
});

describe("ProjectDetails terminal sanitization", () => {
  test("sanitizes terminal escape sequences from git branch names", async () => {
    const repo = join(root, "hostile-branch");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(
      join(repo, ".git", "HEAD"),
      "ref: refs/heads/feat\x1b]52;c;cHduZWQ=\x07\x1b[31m-clean\n",
    );

    const [project] = buildProjects(
      [
        {
          id: "c1",
          path: join(repo, "node_modules"),
          name: "node_modules",
          kind: "node_modules",
          entryType: "directory",
          isSymlink: false,
          estimatedBytes: 1024,
          bytesKnown: true,
          riskTier: "safe",
          reasons: ["default-pattern"],
          selectedByDefault: true,
          projectRoot: repo,
          projectActiveMs: Date.now(),
        } as ScanCandidate,
      ],
      new Set(),
      root,
    );

    let setup!: Awaited<ReturnType<typeof testRender>>;
    await act(async () => {
      setup = await testRender(
        <ProjectDetails
          project={project!}
          selectedIds={new Set()}
          tokens={darkTheme}
          width={64}
          height={24}
          now={Date.now()}
        />,
        { width: 64, height: 24 },
      );
    });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      // sanitizeTerminalText neutralizes control bytes into printable escape text.
      expect(frame).toContain("feat\\x1b");
      expect(frame).toContain("-clean");
      expect(frame).not.toContain("\x1b");
      expect(frame).not.toContain("\x07");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
