import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import {
  artifactScopeKey,
  buildScopeTreeRows,
  candidateMatchesScope,
  isScopeAncestor,
  clearScopeTreeCache,
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

test("append-only discovery reuses unaffected folders and can split a flattened chain", () => {
  clearScopeTreeCache();
  const first = [candidate("/repo/a/x/modules", "a", 10), candidate("/repo/b/cache", "b", 20)];
  const before = buildScopeTreeRows("/repo", first, new Set(), new Set());
  const appended = [...first, candidate("/repo/a/y/modules", "c", 5)];
  const rows = buildScopeTreeRows("/repo", appended, new Set(), new Set(["a"]));
  expect(rows[1]).toBe(before[1]);
  expect(before[2]).toMatchObject({ key: "a/x", count: 1, bytes: 10 });
  expect(rows[2]).toMatchObject({ key: "a", count: 2, bytes: 15, hasChildren: true });
  expect(rows.map((r) => r.label)).toEqual(["all scopes", "b/", "a/", "x/", "y/"]);
  const snapshot = structuredClone(rows);
  clearScopeTreeCache();
  expect(buildScopeTreeRows("/repo", appended, new Set(), new Set(["a"]))).toEqual(snapshot);
});

test("incremental folder observations match fresh builds across seeded structural and selection changes", () => {
  clearScopeTreeCache();
  let seed = 345123;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const folders = ["a/x", "a/y", "b", "c/d/e", ".worktrees/wt/pkg", "a-/x", "a./y", ""];
  let candidates: ScanCandidate[] = [];
  const expanded = new Set(["a", "a/x", "a/y", "c/d/e", ".worktrees/wt/pkg"]);
  for (let step = 0; step < 100; step++) {
    if (step % 15 === 0) candidates = [];
    for (let i = 0; i < 2; i++) {
      const name = `${step * 2 + i}`;
      candidates = [
        ...candidates,
        candidate(`/repo/${folders[random() % folders.length]}/${name}`, name, random() % 4),
      ];
    }
    if (step % 3 === 0)
      candidates = candidates.map((c) => ({ ...c, estimatedBytes: random() % 8 }));
    if (step % 7 === 0) candidates = candidates.slice(1);
    if (step % 9 === 0)
      candidates = candidates.map((c, i) =>
        i === 0 ? { ...c, path: `/repo/moved/${c.name}` } : c,
      );
    const selected = new Set(candidates.filter(() => random() % 2).map((c) => c.id));
    const incremental = buildScopeTreeRows("/repo", candidates, selected, expanded);
    clearScopeTreeCache();
    expect(buildScopeTreeRows("/repo", candidates, selected, expanded)).toEqual(incremental);
  }
  clearScopeTreeCache();
});

test("sizing refreshes reused topology exactly like a fresh rebuild, including scope order and selection", () => {
  const original = [
    candidate("/tmp/tree/a/node_modules", "a", 100),
    candidate("/tmp/tree/b/dist", "b", 1),
    candidate("/tmp/tree/cache", "root", 3),
  ];
  const selected = new Set([original[1]!.id]);
  const expanded = new Set<string>();
  buildScopeTreeRows("/tmp/tree", original, selected, expanded);
  const sized = original.map((c, i) => ({ ...c, estimatedBytes: i === 1 ? 1000 : 0 }));
  const reused = buildScopeTreeRows("/tmp/tree", sized, selected, expanded);
  expect(reused[0]!.bytes).toBe(1000);
  expect(reused[0]!.selectedBytes).toBe(1000);
  expect(reused[1]!.key).toBe("b");
  clearScopeTreeCache();
  expect(reused).toEqual(buildScopeTreeRows("/tmp/tree", sized, selected, expanded));
  // A renamed path invalidates topology; same-length arrays alone are unsafe.
  const moved = sized.map((c, i) => (i === 1 ? { ...c, path: "/tmp/tree/c/dist" } : c));
  const updated = buildScopeTreeRows("/tmp/tree", moved, selected, expanded);
  expect(updated[1]!.key).toBe("c");
  clearScopeTreeCache();
  expect(updated).toEqual(buildScopeTreeRows("/tmp/tree", moved, selected, expanded));
});

describe("scope tree", () => {
  test("a large single scope avoids argument-count overflow", () => {
    const candidates = Array.from({ length: 75_000 }, (_, i) =>
      candidate(`/repo/file-${i}`, `${i}`),
    );
    const rows = buildScopeTreeRows("/repo", candidates, new Set(), new Set());
    expect(rows[0]?.count).toBe(75_000);
    expect(rows[1]?.count).toBe(75_000);
  });
  test("deep scope chains are processed without recursive stack growth", () => {
    const path = `/repo/${Array.from({ length: 3000 }, () => "x").join("/")}/node_modules`;
    const rows = buildScopeTreeRows(
      "/repo",
      [candidate(path, "deep", 10)],
      new Set(["cand_deep"]),
      new Set(),
    );
    expect(rows[0]?.selectedBytes).toBe(10);
    expect(rows[1]?.count).toBe(1);
    expect(rows[1]?.hasChildren).toBe(false);
  });

  test("an oversized optional folder index reports its limit and keeps all candidates", () => {
    const chain = Array.from({ length: 3000 }, () => "x").join("/");
    const candidates = [
      candidate(`/repo/a/${chain}/node_modules`, "a", 10),
      candidate(`/repo/b/${chain}/node_modules`, "b", 20),
    ];
    const rows = buildScopeTreeRows("/repo", candidates, new Set(["cand_b"]), new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toContain("folder index limit");
    expect(rows[0]?.count).toBe(2);
    expect(rows[0]?.bytes).toBe(30);
    expect(rows[0]?.selectedBytes).toBe(20);
  });

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
