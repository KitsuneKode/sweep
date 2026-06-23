import { describe, expect, test } from "bun:test";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import { buildScopeSidebarRows, scopeFilterToSidebarIndex } from "./sidebar.js";
import { applySidebarScope, createUiState, moveSidebarCursor, setScopeFilter } from "./state.js";

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
  test("lists all scopes first then workspace folders", () => {
    const state = createUiState(createPlan());
    const rows = buildScopeSidebarRows(state.targetDir, state.candidates, state.selectedIds);

    expect(rows[0]?.label).toBe("all scopes");
    expect(rows[0]?.count).toBe(2);
    expect(rows.some((row) => row.label === "apps/cli/")).toBe(true);
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
});
