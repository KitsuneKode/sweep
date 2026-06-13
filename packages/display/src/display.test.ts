import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import {
  formatDeletionProgress,
  formatRiskBadge,
  groupCandidatesByKind,
  riskBadgeLabel,
} from "@kitsunekode/sweep-display";

function candidate(
  overrides: Partial<ScanCandidate> & Pick<ScanCandidate, "id" | "name" | "kind">,
): ScanCandidate {
  return {
    path: `/tmp/${overrides.name}`,
    estimatedBytes: 1024,
    isSymlink: false,
    entryType: "directory",
    riskTier: "safe",
    reasons: ["default-pattern"],
    selectedByDefault: true,
    ...overrides,
  };
}

describe("display formatters", () => {
  test("formatRiskBadge maps tiers to stable labels and styling", () => {
    expect(riskBadgeLabel("safe")).toBe("safe");
    expect(riskBadgeLabel("caution")).toBe("warning");
    expect(riskBadgeLabel("dangerous")).toBe("dangerous");

    expect(formatRiskBadge("safe")).toContain("safe");
    expect(formatRiskBadge("caution")).toContain("warning");
    expect(formatRiskBadge("dangerous")).toContain("dangerous");
    expect(formatRiskBadge("blocked")).toContain("blocked");
  });

  test("groupCandidatesByKind groups candidates and totals bytes", () => {
    const groups = groupCandidatesByKind([
      candidate({ id: "a", name: "node_modules", kind: "node_modules", estimatedBytes: 100 }),
      candidate({ id: "b", name: "dist", kind: "dist", estimatedBytes: 200 }),
      candidate({ id: "c", name: "other-dist", kind: "dist", estimatedBytes: 50 }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.kind === "node_modules")?.entries).toHaveLength(1);
    expect(groups.find((group) => group.kind === "dist")?.totalBytes).toBe(250);
  });

  test("formatDeletionProgress renders current progress", () => {
    expect(formatDeletionProgress(2, 5, "/tmp/x")).toContain("2/5");
    expect(formatDeletionProgress(2, 5, "/tmp/x")).toContain("/tmp/x");
  });
});
