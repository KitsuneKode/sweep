import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import {
  formatDeletionProgress,
  formatDeletionStatus,
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

  test("formatDeletionStatus keeps the tally and shrinks a long path", () => {
    const line = formatDeletionStatus({
      current: 1,
      total: 4,
      path: "/home/dev/monorepo/apps/web/node_modules",
      verb: "deleting",
      itemBytes: 1024,
      runningBytes: 4096,
      elapsedMs: 2400,
      columns: 48,
    });
    expect(line.startsWith("deleting [1/4] ")).toBe(true);
    expect(line).toContain("~4.0 KB removed");
    expect(line).not.toContain("freed");
    expect(line).toContain("2.4s");
    expect(line.length).toBeLessThanOrEqual(48);
    expect(line).toContain("…");
  });
});
