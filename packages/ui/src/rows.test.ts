import { describe, expect, test } from "bun:test";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import {
  buildDisplayRows,
  firstSelectableRow,
  lastSelectableRow,
  moveItemRowIndex,
  type UiDisplayRow,
} from "./rows.js";
import { createUiState, upsertCandidates } from "./state.js";

function planWith(candidates: ScanPlan["candidates"]): ScanPlan {
  return {
    protocolVersion: "1",
    targetDir: "/repo",
    selectionPolicy: { mode: "default", includeDangerous: false },
    candidates,
    summary: {
      candidateCount: candidates.length,
      estimatedTotalBytes: 0,
      scannedDirs: 1,
      exact: false,
      selectedCount: 0,
      riskCounts: { safe: candidates.length, caution: 0, dangerous: 0, blocked: 0 },
    },
    selectedCandidateIds: [],
    createdAt: new Date().toISOString(),
  };
}

describe("buildDisplayRows", () => {
  test("omits a heading when a parent has only one artifact", () => {
    const state = createUiState(
      planWith([
        {
          id: "a",
          path: "/repo/apps/cli/dist",
          name: "dist",
          kind: "dist",
          estimatedBytes: 10,
          isSymlink: false,
          entryType: "directory",
          riskTier: "safe",
          reasons: ["default-pattern"],
          selectedByDefault: true,
        },
        {
          id: "b",
          path: "/repo/apps/docs/.next",
          name: ".next",
          kind: ".next",
          estimatedBytes: 20,
          isSymlink: false,
          entryType: "directory",
          riskTier: "safe",
          reasons: ["default-pattern"],
          selectedByDefault: true,
        },
      ]),
    );

    const rows = buildDisplayRows(state);
    expect(rows.every((row) => row.kind === "item")).toBe(true);
    expect(rows).toHaveLength(2);
  });

  test("keeps a heading when several artifacts share a parent", () => {
    const state = createUiState(
      planWith([
        {
          id: "a",
          path: "/repo/apps/cli/dist",
          name: "dist",
          kind: "dist",
          estimatedBytes: 10,
          isSymlink: false,
          entryType: "directory",
          riskTier: "safe",
          reasons: ["default-pattern"],
          selectedByDefault: true,
        },
        {
          id: "b",
          path: "/repo/apps/cli/.next",
          name: ".next",
          kind: ".next",
          estimatedBytes: 20,
          isSymlink: false,
          entryType: "directory",
          riskTier: "safe",
          reasons: ["default-pattern"],
          selectedByDefault: true,
        },
      ]),
    );

    const rows = buildDisplayRows(state);
    expect(rows[0]?.kind).toBe("header");
    expect(rows.filter((row) => row.kind === "item")).toHaveLength(2);
  });
});

function header(key: string): UiDisplayRow {
  return {
    kind: "header",
    groupKey: key,
    label: `${key}/`,
    itemCount: 2,
    selectedCount: 0,
    collapsed: false,
    bytes: 0,
  };
}

function item(id: string): UiDisplayRow {
  return { kind: "item", candidateId: id };
}

describe("moveItemRowIndex", () => {
  // header a / a1 / a2 / header b / b1 / b2
  const rows: UiDisplayRow[] = [
    header("a"),
    item("a1"),
    item("a2"),
    header("b"),
    item("b1"),
    item("b2"),
  ];

  test("steps over a heading instead of landing on it", () => {
    // From the last item of group a, one step down reaches b1, not the heading.
    expect(moveItemRowIndex(rows, 2, 1)).toBe(4);
    expect(moveItemRowIndex(rows, 4, -1)).toBe(2);
  });

  test("moves one item at a time within a group", () => {
    expect(moveItemRowIndex(rows, 1, 1)).toBe(2);
    expect(moveItemRowIndex(rows, 2, -1)).toBe(1);
  });

  test("counts items, not rows, for a page jump", () => {
    expect(moveItemRowIndex(rows, 1, 3)).toBe(5);
  });

  test("settles on the furthest item when the jump runs off the end", () => {
    expect(moveItemRowIndex(rows, 1, 99)).toBe(5);
    expect(moveItemRowIndex(rows, 4, -99)).toBe(1);
  });

  test("snaps onto an item when the cursor starts on a heading", () => {
    expect(moveItemRowIndex(rows, 0, 1)).toBe(1);
    expect(moveItemRowIndex(rows, 3, 0)).toBe(4);
  });

  test("an empty list stays at zero", () => {
    expect(moveItemRowIndex([], 0, 1)).toBe(0);
  });
});

describe("first/lastSelectableRow", () => {
  const rows: UiDisplayRow[] = [header("a"), item("a1"), item("a2"), header("b")];

  test("skip the headings at both ends", () => {
    expect(firstSelectableRow(rows)).toBe(1);
    expect(lastSelectableRow(rows)).toBe(2);
  });

  test("fall back to zero when nothing is selectable", () => {
    expect(firstSelectableRow([header("a")])).toBe(0);
    expect(lastSelectableRow([header("a")])).toBe(0);
  });
});

describe("pinned ordering during a live scan", () => {
  function candidate(id: string, parent: string, name: string, bytes: number): ScanCandidate {
    return {
      id,
      path: `/repo/${parent}/${name}`,
      name,
      kind: "node_modules",
      estimatedBytes: bytes,
      isSymlink: false,
      entryType: "directory",
      riskTier: "safe",
      reasons: ["default-pattern"],
      selectedByDefault: false,
    };
  }

  /** Discovery order: c, a, b — deliberately not size or alpha order. */
  const discovered = [
    candidate("c", "apps/web", "node_modules", 0),
    candidate("a", "apps/cli", "node_modules", 0),
    candidate("b", "packages/core", "node_modules", 0),
  ];

  function scanningState() {
    const base = createUiState(planWith([]));
    return upsertCandidates({ ...base, scanning: true, orderPinned: true }, discovered);
  }

  function itemIds(state: ReturnType<typeof scanningState>) {
    return buildDisplayRows(state)
      .filter((row) => row.kind === "item")
      .map((row) => (row.kind === "item" ? row.candidateId : ""));
  }

  test("holds discovery order instead of sorting by size", () => {
    expect(itemIds(scanningState())).toEqual(["c", "a", "b"]);
  });

  test("sizes arriving mid-scan do not reorder the list", () => {
    let state = scanningState();
    const before = itemIds(state);

    // Sizing makes `b` by far the largest — unpinned this would jump to the top.
    state = upsertCandidates(state, [
      { ...discovered[1]!, estimatedBytes: 5_000 },
      { ...discovered[2]!, estimatedBytes: 900_000 },
      { ...discovered[0]!, estimatedBytes: 1_000 },
    ]);

    expect(itemIds(state)).toEqual(before);
  });

  test("a newly discovered scope appends instead of pushing rows around", () => {
    let state = scanningState();
    const before = itemIds(state);

    state = upsertCandidates(state, [candidate("d", "apps/docs", "dist", 800_000)]);

    // Everything already on screen keeps its position; the new one lands last.
    expect(itemIds(state)).toEqual([...before, "d"]);
  });

  test("unpinning sorts by size, largest first", () => {
    let state = scanningState();
    state = upsertCandidates(state, [
      { ...discovered[1]!, estimatedBytes: 5_000 },
      { ...discovered[2]!, estimatedBytes: 900_000 },
      { ...discovered[0]!, estimatedBytes: 1_000 },
    ]);

    expect(itemIds({ ...state, orderPinned: false })).toEqual(["b", "a", "c"]);
  });

  test("headings stay put while pinned so a second artifact cannot shift rows", () => {
    let state = scanningState();
    const headersBefore = buildDisplayRows(state).filter((row) => row.kind === "header").length;
    expect(headersBefore).toBe(3);

    // A second artifact in an existing scope must not make a heading pop in.
    state = upsertCandidates(state, [candidate("a2", "apps/cli", "dist", 10)]);
    const rows = buildDisplayRows(state);
    expect(rows.filter((row) => row.kind === "header")).toHaveLength(3);
    // The first two rows are untouched: heading, then its original artifact.
    expect(rows[0]?.kind).toBe("header");
    expect(rows[1]).toEqual({ kind: "item", candidateId: "c" });
  });
});
