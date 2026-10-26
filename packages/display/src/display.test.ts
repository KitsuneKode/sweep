import { describe, expect, spyOn, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { createProgressiveScanRenderer } from "./progressive.js";
import {
  formatDeletionProgress,
  formatScanReport,
  truncateMiddle,
  formatBytes,
  formatDeletionStatus,
  formatRiskBadge,
  groupCandidatesByKind,
  riskBadgeLabel,
  printDeletionProgress,
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
  test("progressive candidate lines distinguish partial sizing from known sizes", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const out = spyOn(process.stdout, "write").mockReturnValue(true);
    const renderer = createProgressiveScanRenderer();
    try {
      renderer.onCandidate(
        candidate({ id: "partial", name: "dist", kind: "dist", bytesKnown: false }),
      );
      renderer.onCandidate(
        candidate({ id: "known", name: "target", kind: "target", bytesKnown: true }),
      );
      renderer.onCandidate(
        candidate({
          id: "pending",
          name: "node_modules",
          kind: "node_modules",
          estimatedBytes: 0,
          bytesKnown: false,
        }),
      );
      expect(String(log.mock.calls[0]?.[0])).toContain("~1.0 KiB");
      expect(String(log.mock.calls[1]?.[0])).toContain("1.0 KiB");
      expect(String(log.mock.calls[1]?.[0])).not.toContain("~");
      expect(String(log.mock.calls[2]?.[0])).toContain("~0 B");
    } finally {
      renderer.stopSpinner();
      log.mockRestore();
      out.mockRestore();
    }
  });
  test("deletion progress leaves stdout exclusively for results", () => {
    const out = spyOn(process.stdout, "write").mockReturnValue(true);
    const err = spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      printDeletionProgress(1, 4, "/tmp/owned/dist");
      expect(out).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalled();
      expect(String(err.mock.calls[0]?.[0])).toContain("/tmp/owned/dist");
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
  test("byte labels use binary units and handle invalid and fractional values", () => {
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GiB");
    expect(formatBytes(0.5)).toBe("1 B");
    expect(formatBytes(NaN)).toBe("unknown");
    expect(formatBytes(Infinity)).toBe("unknown");
  });
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
    expect(line).toContain("~4.0 KiB removed");
    expect(line).not.toContain("freed");
    expect(line).toContain("2.4s");
    expect(line.length).toBeLessThanOrEqual(48);
    expect(line).toContain("…");
  });
});

describe("scan report", () => {
  const plain = (lines: string[]) => lines.map((line) => Bun.stripANSI(line));
  const plan = (candidates: ScanCandidate[], selected: string[]) =>
    ({
      protocolVersion: 1,
      targetDir: "/work",
      candidates,
      selectedCandidateIds: selected,
      summary: {
        scannedDirs: 40,
        exact: true,
        riskCounts: {
          safe: candidates.filter((c) => c.riskTier === "safe").length,
          caution: candidates.filter((c) => c.riskTier === "caution").length,
          dangerous: candidates.filter((c) => c.riskTier === "dangerous").length,
          blocked: candidates.filter((c) => c.riskTier === "blocked").length,
        },
      },
    }) as unknown as import("@kitsunekode/sweep-protocol").ScanPlan;

  test("leads with what would be reclaimed, then the largest group first", () => {
    const lines = plain(
      formatScanReport(
        plan(
          [
            candidate({ id: "a", name: ".turbo", kind: ".turbo", path: "/work/a/.turbo" }),
            candidate({
              id: "b",
              name: "node_modules",
              kind: "node_modules",
              path: "/work/app/node_modules",
              estimatedBytes: 4096,
            }),
          ],
          ["a", "b"],
        ),
        "/work",
        { columns: 80 },
      ),
    );
    const headline = lines.find((line) => line.includes("to reclaim"));
    expect(headline).toContain("5.0 KiB to reclaim");
    expect(headline).toContain("2 of 2 selected");
    const groupOrder = lines.filter((line) => /^ (node_modules|\.turbo) /.test(line));
    expect(groupOrder[0]).toStartWith(" node_modules");
    // Rows read relative to the scan target.
    expect(lines.some((line) => line.includes("● app/node_modules"))).toBe(true);
    expect(lines.some((line) => line.includes("/work/"))).toBe(false);
  });

  test("a long group folds its tail into one counted line, and says why items stay", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      candidate({
        id: `t${index}`,
        name: "target",
        kind: "target",
        path: `/work/p${index}/target`,
        estimatedBytes: 1000 + index,
      }),
    );
    const risky = candidate({
      id: "r",
      name: "target",
      kind: "target",
      path: "/work/notes/target",
      riskTier: "dangerous",
      selectedByDefault: false,
    });
    const tracked = candidate({
      id: "g",
      name: "target",
      kind: "target",
      path: "/work/kept/target",
      riskTier: "blocked",
      reasons: ["git-tracked"],
      selectedByDefault: false,
    });
    const lines = plain(
      formatScanReport(
        plan(
          [...many, risky, tracked],
          many.map((c) => c.id),
        ),
        "/work",
        { columns: 80 },
      ),
    );
    expect(lines.some((line) => line.includes("+ 5 more"))).toBe(true);
    // Selected rows lead; the largest selected row is first.
    expect(lines.find((line) => line.includes("●"))).toContain("p8/target");
    expect(lines.some((line) => line.includes("1 left for you to decide"))).toBe(true);
    expect(lines.some((line) => line.includes("1 blocked"))).toBe(true);
  });

  test("an empty scan says so plainly", () => {
    const lines = plain(formatScanReport(plan([], []), "/work", { columns: 80 }));
    expect(lines.some((line) => line.includes("Nothing to clean."))).toBe(true);
    expect(lines.some((line) => line.includes("to reclaim"))).toBe(false);
  });

  test("truncateMiddle keeps both ends of a long path", () => {
    expect(truncateMiddle("apps/web/node_modules", 40)).toBe("apps/web/node_modules");
    const cut = truncateMiddle("a/very/long/monorepo/path/to/packages/web/node_modules", 24);
    expect(cut).toHaveLength(24);
    expect(cut).toContain("…");
    expect(cut.endsWith("node_modules")).toBe(true);
  });
});
