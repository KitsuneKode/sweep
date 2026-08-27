import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import {
  artifactScopeKey,
  buildScopeTreeRows,
  candidateMatchesScope,
  isScopeAncestor,
} from "./scope-tree.js";

function candidate(path: string, name: string, bytes = 1): ScanCandidate {
  return {
    id: `cand_${name}`,
    path,
    name,
    kind: "node_modules",
    estimatedBytes: bytes,
    isSymlink: false,
    entryType: "directory",
    riskTier: "safe",
    reasons: ["default-pattern"],
    selectedByDefault: true,
  };
}

describe("scope tree", () => {
  test("flattens empty directory chains and keeps siblings nested", () => {
    const rows = buildScopeTreeRows(
      "/repo",
      [
        candidate("/repo/.claude/worktrees/wt-a/apps/cli/node_modules", "nm-a", 100),
        candidate("/repo/.claude/worktrees/wt-b/apps/cli/node_modules", "nm-b", 50),
        candidate("/repo/apps/cli/node_modules", "nm-cli", 10),
      ],
      new Set(),
      new Set(),
    );

    expect(rows[0]?.label).toBe("all scopes");
    expect(rows.map((row) => row.label)).toEqual(["all scopes", ".claude/worktrees/", "apps/cli/"]);
    expect(rows[1]?.hasChildren).toBe(true);
    expect(rows[1]?.count).toBe(2);
    expect(rows[2]?.hasChildren).toBe(false);
  });

  test("l-expand reveals flattened child folders", () => {
    const collapsed = buildScopeTreeRows(
      "/repo",
      [
        candidate("/repo/.claude/worktrees/wt-a/apps/cli/node_modules", "nm-a", 100),
        candidate("/repo/.claude/worktrees/wt-b/apps/cli/node_modules", "nm-b", 50),
      ],
      new Set(),
      new Set(),
    );
    const parent = collapsed[1];
    expect(parent?.key).toBe(".claude/worktrees");

    const expanded = buildScopeTreeRows(
      "/repo",
      [
        candidate("/repo/.claude/worktrees/wt-a/apps/cli/node_modules", "nm-a", 100),
        candidate("/repo/.claude/worktrees/wt-b/apps/cli/node_modules", "nm-b", 50),
      ],
      new Set(),
      new Set([parent?.key ?? ""]),
    );

    expect(expanded.map((row) => `${row.depth}:${row.label}`)).toEqual([
      "0:all scopes",
      "0:.claude/worktrees/",
      "1:wt-a/apps/cli/",
      "1:wt-b/apps/cli/",
    ]);
  });

  test("candidateMatchesScope includes nested folders of the selected prefix", () => {
    expect(artifactScopeKey("/repo", "/repo/apps/cli/dist")).toBe("apps/cli");
    expect(candidateMatchesScope("apps/cli", "apps")).toBe(true);
    expect(candidateMatchesScope("apps/docs", "apps/cli")).toBe(false);
    expect(candidateMatchesScope("", "")).toBe(true);
    expect(candidateMatchesScope("apps/cli", "")).toBe(false);
    expect(isScopeAncestor("apps", "apps/cli")).toBe(true);
    expect(isScopeAncestor("apps/cli", "apps")).toBe(false);
  });
});
