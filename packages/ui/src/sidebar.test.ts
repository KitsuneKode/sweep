import { describe, expect, test } from "bun:test";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import {
  buildScopeSidebarRows,
  scopeFilterToSidebarIndex,
  sidebarColumnLayout,
  sidebarCountWidth,
  sidebarBytesWidth,
  type ScopeSidebarRow,
} from "./sidebar.js";
import { applySidebarScope, createUiState, setScopeFilter } from "./state.js";

function createPlan(): ScanPlan {
  return {
    protocolVersion: "1",
    targetDir: "/tmp/sweep-ui",
    selectionPolicy: { mode: "default", includeDangerous: false },
    candidates: [
      {
        id: "cand_root",
        path: "/tmp/sweep-ui/node_modules",
        name: "node_modules",
        kind: "node_modules",
        estimatedBytes: 1024,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: true,
      },
      {
        id: "cand_nested",
        path: "/tmp/sweep-ui/apps/cli/dist",
        name: "dist",
        kind: "build",
        estimatedBytes: 4096,
        isSymlink: false,
        entryType: "directory",
        riskTier: "caution",
        reasons: ["build-output"],
        selectedByDefault: false,
      },
    ],
    summary: {
      candidateCount: 2,
      estimatedTotalBytes: 5120,
      scannedDirs: 3,
      exact: false,
      selectedCount: 1,
      riskCounts: { safe: 1, caution: 1, dangerous: 0, blocked: 0 },
    },
    selectedCandidateIds: ["cand_root"],
    createdAt: new Date().toISOString(),
  };
}

describe("scope sidebar rows", () => {
  test("sidebar rows after all-scopes are heaviest first", () => {
    const state = createUiState(createPlan());
    const rows = buildScopeSidebarRows(state.targetDir, state.candidates, state.selectedIds);
    expect(rows[0]?.label).toBe("all scopes");
    expect(rows[0]?.count).toBe(2);
    expect(rows[0]?.bytes).toBe(5120);
    expect(rows[0]?.selectedBytes).toBe(1024);
    expect(rows.slice(1).map((row) => row.label)).toEqual(["apps/cli/", "project root"]);
    expect(rows[1]?.bytes).toBeGreaterThan(rows[2]?.bytes ?? 0);
  });

  test("moveSidebarCursor and applySidebarScope update scope filter", () => {
    let state = createUiState(createPlan());
    const rows = buildScopeSidebarRows(state.targetDir, state.candidates, state.selectedIds);
    const nestedIndex = rows.findIndex((row) => row.label === "apps/cli/");

    state = { ...state, sidebarIndex: nestedIndex, focus: "sidebar" };
    state = applySidebarScope(state);

    expect(state.scopeFilter).toBe("apps/cli");
    expect(state.focus).toBe("list");
  });

  test("setScopeFilter keeps sidebar index in sync", () => {
    const state = createUiState(createPlan());
    const rows = buildScopeSidebarRows(state.targetDir, state.candidates, state.selectedIds);
    const next = setScopeFilter(state, "apps/cli");

    expect(next.sidebarIndex).toBe(scopeFilterToSidebarIndex("apps/cli", rows));
  });

  test("sidebarColumnLayout hides bytes when the pane is cramped", () => {
    const wide = sidebarColumnLayout(36, 2, 6);
    expect(wide.showBytes).toBe(true);
    expect(wide.maxLabelWidth).toBeGreaterThanOrEqual(8);

    const narrow = sidebarColumnLayout(16, 3, 8);
    expect(narrow.showBytes).toBe(false);
    expect(narrow.maxLabelWidth).toBeGreaterThanOrEqual(6);
  });
});

describe("column widths on large trees", () => {
  function row(count: number, bytes: number): ScopeSidebarRow {
    return {
      key: `k${count}`,
      label: "scope/",
      depth: 0,
      hasChildren: false,
      count,
      selectedCount: 0,
      bytes,
      selectedBytes: 0,
    };
  }

  test("widths come from the widest row", () => {
    const rows = [row(1, 10), row(12345, 1024 ** 3), row(7, 0)];
    expect(sidebarCountWidth(rows)).toBe(5);
    expect(sidebarBytesWidth(rows)).toBe(6);
  });

  test("empty input falls back to the minimum widths", () => {
    expect(sidebarCountWidth([])).toBe(1);
    expect(sidebarBytesWidth([])).toBe(6);
  });

  test("a large tree is measured without spreading it into arguments", () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => row(i, i));
    expect(sidebarCountWidth(rows)).toBe(5);
    expect(sidebarBytesWidth(rows)).toBe(6);
  });
});
