import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { gitBranch } from "./project-details.js";
import { ProjectDetails } from "./ProjectDetails.js";
import { buildProjectRows, buildProjects } from "./projects.js";
import { ProjectsView } from "./ProjectsView.js";
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

  test("shows full worktree status text in details margin even at minimum panel width", async () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    const day = 86_400_000;
    const wtDir = join(root, "app", ".worktrees", "gone-wt");
    mkdirSync(wtDir, { recursive: true });

    const [goneProject, mergedProject] = buildProjects(
      [
        {
          id: "g1",
          path: join(wtDir, "node_modules"),
          name: "node_modules",
          kind: "node_modules",
          entryType: "directory",
          isSymlink: false,
          estimatedBytes: 2048,
          bytesKnown: true,
          riskTier: "safe",
          reasons: ["default-pattern"],
          selectedByDefault: true,
          projectRoot: wtDir,
          projectActiveMs: now - 40 * day,
          worktreeOf: join(root, "app"),
          worktreeState: "upstream_gone",
        } as ScanCandidate,
        {
          id: "m1",
          path: join(root, "app", ".worktrees", "done-wt", "node_modules"),
          name: "node_modules",
          kind: "node_modules",
          entryType: "directory",
          isSymlink: false,
          estimatedBytes: 1024,
          bytesKnown: true,
          riskTier: "safe",
          reasons: ["default-pattern"],
          selectedByDefault: true,
          projectRoot: join(root, "app", ".worktrees", "done-wt"),
          projectActiveMs: now - 5 * day,
          worktreeOf: join(root, "app"),
          worktreeState: "merged",
        } as ScanCandidate,
      ],
      new Set(),
      root,
      now,
    );

    // Minimum panel width (38 cols): full sentence must still fit without clipping.
    let setup!: Awaited<ReturnType<typeof testRender>>;
    await act(async () => {
      setup = await testRender(
        <ProjectDetails
          project={goneProject!}
          selectedIds={new Set()}
          tokens={darkTheme}
          width={38}
          height={24}
          now={now}
        />,
        { width: 38, height: 24 },
      );
    });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("worktree");
      expect(frame).toContain("app");
      expect(frame).toContain("Tracking branch missing · check git");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }

    await act(async () => {
      setup = await testRender(
        <ProjectDetails
          project={mergedProject!}
          selectedIds={new Set()}
          tokens={darkTheme}
          width={44}
          height={24}
          now={now}
        />,
        { width: 44, height: 24 },
      );
    });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("worktree");
      expect(frame).toContain("Merged into default branch · clean");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("ProjectsView keeps repo name and short branch-missing token visible at 80, 100, and 120 columns", async () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    const day = 86_400_000;
    const candidates: ScanCandidate[] = [
      {
        id: "done",
        path: join(root, "app", ".worktrees", "done", "node_modules"),
        name: "node_modules",
        kind: "node_modules",
        entryType: "directory",
        isSymlink: false,
        estimatedBytes: 13,
        bytesKnown: true,
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: true,
        projectRoot: join(root, "app", ".worktrees", "done"),
        projectActiveMs: now - 10 * day,
        worktreeOf: join(root, "app"),
        worktreeState: "merged",
      } as ScanCandidate,
      {
        id: "old-gone",
        path: join(root, "app", ".worktrees", "old-gone", "node_modules"),
        name: "node_modules",
        kind: "node_modules",
        entryType: "directory",
        isSymlink: false,
        estimatedBytes: 17,
        bytesKnown: true,
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: true,
        projectRoot: join(root, "app", ".worktrees", "old-gone"),
        projectActiveMs: now - 40 * day,
        worktreeOf: join(root, "app"),
        worktreeState: "upstream_gone",
      } as ScanCandidate,
    ];
    const projects = buildProjects(candidates, new Set(), root, now);
    const rows = buildProjectRows(projects, new Set());

    for (const width of [80, 100, 120]) {
      let setup!: Awaited<ReturnType<typeof testRender>>;
      await act(async () => {
        setup = await testRender(
          <ProjectsView
            tokens={darkTheme}
            width={width}
            height={24}
            target={root}
            rows={rows}
            cursor={1}
            now={now}
            scanning={false}
            sizedLabel=""
            reclaimableBytes={30}
            idleBytes={17}
            projectCount={2}
            selectedBytes={0}
            selectedCount={0}
            selectedIds={new Set()}
            diskFree={null}
            filter=""
            searchFocused={false}
            footer={<text content="" />}
            onFilterInput={() => {}}
            onFilterSubmit={() => {}}
            onRowPress={() => {}}
            onCursorDelta={() => {}}
          />,
          { width, height: 24 },
        );
      });
      try {
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("app · merged");
        expect(frame).toContain("app · branch missing");
        expect(frame).not.toContain("…missing");
      } finally {
        await act(async () => {
          setup.renderer.destroy();
        });
      }
    }
  });
});
