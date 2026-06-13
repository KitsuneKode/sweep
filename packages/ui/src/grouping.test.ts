import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { groupCandidatesByScope } from "./grouping.js";

function candidate(
  path: string,
  name: string,
  kind: ScanCandidate["kind"] = "node_modules",
): ScanCandidate {
  return {
    id: `cand_${name}`,
    path,
    name,
    kind,
    estimatedBytes: 0,
    isSymlink: false,
    entryType: "directory",
    riskTier: "safe",
    reasons: ["default-pattern"],
    selectedByDefault: true,
  };
}

describe("groupCandidatesByScope", () => {
  test("puts scan-root artifacts in project root", () => {
    const groups = groupCandidatesByScope("/repo", [
      candidate("/repo/node_modules", "node_modules", "node_modules"),
      candidate("/repo/.turbo", ".turbo", ".turbo"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("project root");
    expect(groups[0]?.candidateIds).toHaveLength(2);
  });

  test("groups nested artifacts by parent directory", () => {
    const groups = groupCandidatesByScope("/repo", [
      candidate("/repo/apps/cli/node_modules", "node_modules-cli", "node_modules"),
      candidate("/repo/packages/core/dist", "dist", "dist"),
      candidate("/repo/node_modules", "node_modules-root", "node_modules"),
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "project root",
      "apps/cli/",
      "packages/core/",
    ]);
  });
});
