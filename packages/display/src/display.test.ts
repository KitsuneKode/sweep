import { describe, expect, spyOn, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
  PROTOCOL_VERSION,
  type ScanCandidate,
  type StatusSummary,
} from "@kitsunekode/sweep-protocol";
import { createProgressiveScanRenderer } from "./progressive.js";
import {
  createPalette,
  createSpinner,
  formatDeletionProgress,
  formatDoctorReport,
  formatError,
  formatInitDryRunJson,
  formatInitReport,
  formatPlanInfo,
  formatScanReport,
  formatStatsSummary,
  formatStatusSummary,
  idleLabel,
  plural,
  resolveColorDepth,
  truncateMiddle,
  formatBytes,
  formatDeletionStatus,
  formatRiskBadge,
  groupCandidatesByKind,
  riskBadgeLabel,
  printDeletionProgress,
  printStatusSummary,
  type DoctorCheckEntry,
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
    expect(riskBadgeLabel("caution")).toBe("caution");
    expect(riskBadgeLabel("dangerous")).toBe("dangerous");
    expect(riskBadgeLabel("blocked")).toBe("blocked");

    expect(formatRiskBadge("safe")).toContain("safe");
    expect(formatRiskBadge("caution")).toContain("caution");
    expect(formatRiskBadge("caution")).not.toContain("warning");
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
        { columns: 80, disk: null },
      ),
    );
    const headline = lines.find((line) => line.includes("to reclaim"));
    expect(headline).toContain("5.0 KiB to reclaim");
    expect(headline).toContain("2 of 2 selected");
    const firstGroup = lines.find((line) => /^ ● (node_modules|\.turbo) /.test(line));
    expect(firstGroup).toStartWith(" ● node_modules");
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
        { columns: 80, disk: null },
      ),
    );
    expect(lines.some((line) => line.includes("+ 5 more"))).toBe(true);
    // Selected rows lead; the largest selected row is first.
    expect(lines.find((line) => line.startsWith("   ● "))).toContain("p8/target");
    expect(lines.some((line) => line.includes("1 left for you to decide"))).toBe(true);
    expect(lines.some((line) => line.includes("1 blocked"))).toBe(true);
  });

  test("advice: warns about projects worked on today and suggests --idle for idle ones", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    const day = 86_400_000;
    const lines = plain(
      formatScanReport(
        plan(
          [
            candidate({
              id: "hot",
              name: "target",
              kind: "target",
              path: "/work/app/target",
              estimatedBytes: 4096,
              projectActiveMs: now - 3_600_000,
            }),
            candidate({
              id: "old",
              name: "node_modules",
              kind: "node_modules",
              path: "/work/legacy/node_modules",
              estimatedBytes: 2048,
              projectActiveMs: now - 90 * day,
            }),
          ],
          ["hot", "old"],
        ),
        "/work",
        { columns: 100, disk: { free: 10 * 1024 ** 3, total: 200 * 1024 ** 3 }, now },
      ),
    );
    const text = lines.join("\n");
    expect(text).toContain("4.0 KiB of that is in projects worked on today (app)");
    expect(text).toContain("2.0 KiB is in projects idle 30+ days");
    expect(text).toContain("sweep --idle 30d");
    expect(text).toContain("10.0 GiB free of 200.0 GiB");
    expect(text).toContain("idle 3mo");
    expect(text).toContain("idle 1h");
  });

  test("unprovable project activity renders as unknown idle and is not suggested as idle", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    const lines = plain(
      formatScanReport(
        plan(
          [
            candidate({
              id: "unk",
              name: "node_modules",
              kind: "node_modules",
              path: "/work/huge/node_modules",
              projectRoot: "/work/huge",
              estimatedBytes: 4096,
            }),
          ],
          ["unk"],
        ),
        "/work",
        { columns: 100, disk: null, now },
      ),
    );
    const text = lines.join("\n");
    expect(text).toContain("idle ?");
    expect(text).not.toContain("projects idle 30+ days");
  });

  test("cloud-sync candidates keep selection and print an informational notice", () => {
    const lines = plain(
      formatScanReport(
        plan(
          [
            candidate({
              id: "cs",
              name: "node_modules",
              kind: "node_modules",
              path: "/work/Dropbox/app/node_modules",
              reasons: ["default-pattern", "cloud-sync"],
            }),
          ],
          ["cs"],
        ),
        "/work",
        { columns: 100, disk: null },
      ),
    );
    const text = lines.join("\n");
    expect(text).toContain("1 of 1 selected");
    expect(text).toContain("cloud-synced");
    expect(text).toContain("1 candidate is inside a cloud-synced folder");
  });

  test("an empty scan says so plainly", () => {
    const lines = plain(formatScanReport(plan([], []), "/work", { columns: 80, disk: null }));
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

  test("scan report surfaces honest 'about X freed' and disk gain when hardlinks inflate apparent bytes", () => {
    const p = plan(
      [
        candidate({
          id: "a",
          name: "node_modules",
          kind: "node_modules",
          path: "/work/a/node_modules",
          estimatedBytes: 10 * 1024 * 1024,
          uniqueBytes: 1024 * 1024,
        }),
        candidate({
          id: "b",
          name: "node_modules",
          kind: "node_modules",
          path: "/work/b/node_modules",
          estimatedBytes: 10 * 1024 * 1024,
          uniqueBytes: 1024 * 1024,
        }),
      ],
      ["a", "b"],
    );
    p.summary.uniqueTotalBytes = 2 * 1024 * 1024;
    const lines = plain(
      formatScanReport(p, "/work", {
        columns: 110,
        disk: { free: 100 * 1024 * 1024, total: 200 * 1024 * 1024 },
      }),
    );
    const text = lines.join("\n");
    expect(text).toContain("about 2.0 MiB freed");
    expect(text).toContain("20.0 MiB apparent · shared hardlinks");
    expect(text).toContain("up to 102.0 MiB free");
  });

  test("scan report falls back to apparent with qualifier when uniqueBytesPartial is set", () => {
    const p = plan(
      [
        candidate({
          id: "a",
          name: "node_modules",
          kind: "node_modules",
          path: "/work/a/node_modules",
          estimatedBytes: 10 * 1024 * 1024,
          uniqueBytes: 1024 * 1024,
        }),
        candidate({
          id: "b",
          name: "node_modules",
          kind: "node_modules",
          path: "/work/b/node_modules",
          estimatedBytes: 10 * 1024 * 1024,
          uniqueBytes: 1024 * 1024,
        }),
      ],
      ["a", "b"],
    );
    p.summary.uniqueTotalBytes = 2 * 1024 * 1024;
    p.summary.uniqueBytesPartial = true;
    const lines = plain(
      formatScanReport(p, "/work", {
        columns: 110,
        disk: { free: 100 * 1024 * 1024, total: 200 * 1024 * 1024 },
      }),
    );
    const text = lines.join("\n");
    expect(text).not.toContain("about 2.0 MiB freed");
    expect(text).toContain("20.0 MiB");
    expect(text).toContain("shared hardlinks not fully counted");
    expect(text).toContain("up to 120.0 MiB free");
  });

  test("status summary falls back to apparent with qualifier when uniqueBytesPartial is set", () => {
    const logged: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      printStatusSummary({
        protocolVersion: "1",
        targetDir: "/work",
        createdAt: "2026-01-01T00:00:00.000Z",
        scannedDirs: 10,
        skippedDirs: 0,
        bytesPartial: false,
        partialByteCount: 0,
        complete: true,
        reclaimableBytes: 20 * 1024 * 1024,
        uniqueReclaimableBytes: 2 * 1024 * 1024,
        uniqueBytesPartial: true,
        safeBytes: 20 * 1024 * 1024,
        cautionBytes: 0,
        protectedCount: 0,
        protectedBytes: 0,
        idle: {
          days: 30,
          windowMs: 30 * 86_400_000,
          windowLabel: "30+ days",
          projects: 0,
          bytes: 0,
          kinds: [],
        },
        finishedWorktrees: { projects: 0, bytes: 0, kinds: [], items: [] },
        branchMissingWorktrees: { projects: 0, bytes: 0 },
        kinds: [{ kind: "node_modules", bytes: 20 * 1024 * 1024, count: 2 }],
        projects: [],
      });
    } finally {
      spy.mockRestore();
    }
    const text = plain(logged).join("\n");
    expect(text).not.toContain("about 2.0 MiB freed");
    expect(text).toContain("20.0 MiB you could free");
    expect(text).toContain("shared hardlinks not fully counted");
  });
});

function captureStatus(status: StatusSummary): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(stripVTControlCharacters(args.map(String).join(" ")));
  };
  try {
    printStatusSummary(status);
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

function baseStatus(overrides: Partial<StatusSummary> = {}): StatusSummary {
  return {
    protocolVersion: PROTOCOL_VERSION,
    targetDir: "/work",
    createdAt: "2026-11-28T00:00:00.000Z",
    scannedDirs: 10,
    skippedDirs: 0,
    bytesPartial: false,
    partialByteCount: 0,
    complete: true,
    reclaimableBytes: 0,
    safeBytes: 0,
    cautionBytes: 0,
    protectedCount: 0,
    protectedBytes: 0,
    idle: {
      days: 30,
      windowMs: 30 * 86_400_000,
      windowLabel: "30+ days",
      projects: 0,
      bytes: 0,
      kinds: [],
    },
    finishedWorktrees: {
      projects: 0,
      bytes: 0,
      kinds: [],
      items: [],
    },
    branchMissingWorktrees: {
      projects: 0,
      bytes: 0,
    },
    kinds: [],
    projects: [],
    ...overrides,
  };
}

describe("printStatusSummary", () => {
  test("distinguishes guarded-only trees from truly empty trees and keeps coverage warnings", () => {
    const empty = captureStatus(baseStatus());
    expect(empty).toContain("Nothing to free here.");

    const guardedOnly = captureStatus(
      baseStatus({
        protectedCount: 2,
        protectedBytes: 4096,
        skippedDirs: 1,
        complete: false,
      }),
    );
    expect(guardedOnly).toContain("Nothing automatically reclaimable here.");
    expect(guardedOnly).toContain("2 guarded items found (4.0 KiB)");
    expect(guardedOnly).toContain("incomplete scan: 1 folder could not be read");
  });

  test("renders partial bytes, exact sub-day idle duration, and worktree parity", () => {
    const output = captureStatus(
      baseStatus({
        skippedDirs: 2,
        bytesPartial: true,
        partialByteCount: 1,
        complete: false,
        reclaimableBytes: 8192,
        safeBytes: 8192,
        kinds: [{ kind: "node_modules", bytes: 8192, count: 2 }],
        idle: {
          days: 1,
          windowMs: 12 * 3_600_000,
          windowLabel: "12+ hours",
          projects: 1,
          bytes: 4096,
          kinds: [{ kind: "node_modules", bytes: 4096, count: 1 }],
        },
        finishedWorktrees: {
          projects: 1,
          bytes: 4096,
          kinds: [{ kind: "node_modules", bytes: 4096, count: 1 }],
          items: [
            {
              name: "done-wt",
              path: "/work/app/.worktrees/done-wt",
              bytes: 4096,
              idleDays: 3,
              idleMs: 3 * 86_400_000,
              worktreeOf: "/work/app",
              worktreeState: "merged",
            },
          ],
        },
        branchMissingWorktrees: {
          projects: 1,
          bytes: 4096,
        },
        projects: [
          {
            name: "gone-wt",
            path: "/work/app/.worktrees/gone-wt",
            bytes: 4096,
            idleDays: 0,
            idleMs: 14 * 3_600_000,
            worktreeOf: "/work/app",
            worktreeState: "upstream_gone",
          },
        ],
      }),
    );
    expect(output).toContain("~8.0 KiB you could free");
    expect(output).toContain("4.0 KiB in 1 finished worktree");
    expect(output).toContain("4.0 KiB in 1 project idle 12+ hours");
    expect(output).toContain("1 worktree with tracking branch missing (4.0 KiB) · check git");
    expect(output).toContain(
      "incomplete scan: 2 folders could not be read · 1 item partially sized",
    );
    expect(output).toContain("Finished worktrees");
    expect(output).toContain("done-wt (app · merged)");
    expect(output).toContain("Idle 12+ hours");
    expect(output).toContain("gone-wt (app · branch missing)");
    expect(output).toContain("14 hours");
  });

  test("aligns byte columns across kinds, finished worktrees, and idle sections", () => {
    const lines = formatStatusSummary(
      baseStatus({
        reclaimableBytes: 140 * 1024 * 1024,
        safeBytes: 140 * 1024 * 1024,
        kinds: [
          { kind: "node_modules", bytes: 91 * 1024 * 1024, count: 7 },
          { kind: ".next", bytes: 7 * 1024 * 1024, count: 1 },
        ],
        finishedWorktrees: {
          projects: 1,
          bytes: 15 * 1024 * 1024,
          kinds: [],
          items: [
            {
              name: "wt-merged-billing",
              path: "/work/.worktrees/wt-merged-billing",
              bytes: 15 * 1024 * 1024,
              idleDays: 10,
              idleMs: 10 * 86_400_000,
              worktreeOf: "/work/core-api",
              worktreeState: "merged",
            },
          ],
        },
        projects: [
          {
            name: "old-cli",
            path: "/work/old-cli",
            bytes: 9 * 1024 * 1024,
            idleDays: 45,
            idleMs: 45 * 86_400_000,
          },
          {
            name: "just-touched",
            path: "/work/just-touched",
            bytes: 1024 * 1024,
            idleDays: 0,
            idleMs: 20_000,
          },
        ],
      }),
      { tty: true, columns: 100, palette: createPalette({ depth: "none" }) },
    );

    const sizeCols = lines.map((line) => line.indexOf("MiB")).filter((col) => col > 20);
    // Every table row's MiB unit aligns on the exact same terminal column.
    expect(sizeCols.length).toBe(5);
    expect(new Set(sizeCols).size).toBe(1);
    expect(lines.join("\n")).toContain("active now");
  });
});

describe("Direction C+ CLI palette & color capability", () => {
  test("respects NO_COLOR, FORCE_COLOR, non-TTY, 16-color, and truecolor", () => {
    expect(resolveColorDepth({ isTTY: true }, { NO_COLOR: "1", COLORTERM: "truecolor" })).toBe(
      "none",
    );
    expect(resolveColorDepth({ isTTY: true }, { NO_COLOR: "1", FORCE_COLOR: "3" })).toBe("none");
    expect(resolveColorDepth({ isTTY: false }, {})).toBe("none");
    expect(resolveColorDepth({ isTTY: false }, { FORCE_COLOR: "0" })).toBe("none");
    expect(resolveColorDepth({ isTTY: false }, { FORCE_COLOR: "3" })).toBe("truecolor");
    expect(resolveColorDepth({ isTTY: false }, { FORCE_COLOR: "2" })).toBe("256");
    expect(resolveColorDepth({ isTTY: false }, { FORCE_COLOR: "1", TERM: "xterm-16color" })).toBe(
      "16",
    );
    expect(resolveColorDepth({ isTTY: true }, { TERM: "xterm-16color" })).toBe("16");
    expect(resolveColorDepth({ isTTY: true }, { TERM: "dumb" })).toBe("none");
    expect(resolveColorDepth({ isTTY: true }, { TERM: "xterm-256color" })).toBe("256");
    expect(
      resolveColorDepth({ isTTY: true }, { TERM: "xterm-256color", COLORTERM: "truecolor" }),
    ).toBe("truecolor");

    const none = createPalette({ depth: "none" });
    expect(none.accent("sweep")).toBe("sweep");
    expect(none.positive("ok")).not.toContain("\x1b");

    const c16 = createPalette({ depth: "16" });
    expect(c16.accent("sweep")).toContain("\x1b[94m");
    expect(c16.accent("sweep")).not.toContain("38;2;");

    const tc = createPalette({ depth: "truecolor" });
    expect(tc.accent("sweep")).toContain("\x1b[38;2;96;165;250m");
    expect(tc.positive("ok")).toContain("\x1b[38;2;106;213;139m");
    expect(tc.warning("caution")).toContain("\x1b[38;2;238;193;84m");
    expect(tc.danger("danger")).toContain("\x1b[38;2;252;110;106m");
  });
});

describe("formatDoctorReport", () => {
  const sampleChecks: DoctorCheckEntry[] = [
    { name: "apply_lock", ok: true, detail: "available" },
    { name: "protocol", ok: true, detail: "1" },
    {
      name: "filesystem_identity",
      ok: true,
      detail: "stable root identifier available; descendants are checked individually at apply",
    },
    { name: "target", ok: true, detail: "/var/tmp/workspace/invalid-config" },
    {
      name: "config",
      ok: false,
      detail:
        "Failed to parse config at /var/tmp/workspace/invalid-config/.sweeprc: JSON Parse error: Expected '}'",
      reasonKind: "config_invalid",
      reason: "Failed to parse config.",
    },
    { name: "config_dir", ok: true, detail: "/var/tmp/env/config" },
    { name: "patterns", ok: false, detail: "config error", reasonKind: "config_invalid" },
    { name: "disabled_patterns", ok: true, detail: "0" },
    {
      name: "opentui",
      ok: true,
      detail:
        "0.6.8 (/home/dev/worktrees/sweep/node_modules/.bun/@opentui+core@0.6.8+64015adf11caec84/node_modules/@opentui/core/index.bun.js)",
    },
    {
      name: "rust_engine",
      ok: true,
      detail:
        "/home/dev/worktrees/sweep/node_modules/.bun/@kitsunekode+sweep-engine-linux-64@0.5.3/node_modules/@kitsunekode/sweep-engine-linux-64/bin/sweep-engine",
    },
    {
      name: "rust_apply_safety",
      ok: true,
      detail: "controlled cancellation and plan identity supported",
    },
    {
      name: "dry_scan",
      ok: false,
      detail: "skipped (config error: Failed to parse config)",
      reasonKind: "config_invalid",
    },
  ];

  test("renders grouped TTY report with banner, glyphs, and middle-truncated paths within terminal width", () => {
    const lines = formatDoctorReport(sampleChecks, {
      targetDir: "/var/tmp/workspace/invalid-config",
      protocolVersion: "1",
      columns: 90,
      tty: true,
      palette: createPalette({ depth: "truecolor" }),
    });
    const stripped = lines.map((line) => stripVTControlCharacters(line));
    const joined = stripped.join("\n");

    expect(joined).toContain("◆ sweep doctor");
    expect(joined).toContain("! 3 warnings");
    expect(joined).toContain("9 checks passed");
    expect(joined).toContain("protocol v1");
    expect(joined).toContain("ENVIRONMENT & SAFETY");
    expect(joined).toContain("CONFIGURATION");
    expect(joined).toContain("RUNTIME & ENGINE");
    expect(joined).toContain("✓ apply lock");
    expect(joined).toContain("! config");
    expect(joined).toContain("0.6.8 (");
    expect(joined).toContain("…");
    // No line exceeds the terminal width (prevents mid-word wrapping).
    for (const line of stripped) {
      expect(line.length).toBeLessThanOrEqual(90);
    }
  });

  test("supports failure status glyph, NO_COLOR TTY, and plain non-TTY output without glyph-only meaning", () => {
    const withFailure: DoctorCheckEntry[] = [
      { name: "apply_lock", ok: false, status: "fail", detail: "lock corrupted" },
      { name: "protocol", ok: true, detail: "1" },
    ];
    const noColorLines = formatDoctorReport(withFailure, {
      targetDir: "/var/tmp/work",
      protocolVersion: "1",
      tty: true,
      palette: createPalette({ depth: "none" }),
    });
    const noColorText = noColorLines.join("\n");
    expect(noColorText).not.toContain("\x1b");
    expect(noColorText).toContain("✗ 1 failure");
    expect(noColorText).toContain("✗ apply lock");

    const plainLines = formatDoctorReport(sampleChecks, {
      targetDir: "/var/tmp/workspace/invalid-config",
      protocolVersion: "1",
      tty: false,
      palette: createPalette({ depth: "none" }),
    });
    const plainText = plainLines.join("\n");
    expect(plainText).not.toContain("\x1b");
    expect(plainText).toContain("sweep doctor: 3 warnings, 9 checks passed (protocol v1)");
    expect(plainText).toContain("ok    apply_lock");
    expect(plainText).toContain("warn  config");
  });

  test("quiet mode prints nothing when all checks pass", () => {
    const okChecks: DoctorCheckEntry[] = [
      { name: "apply_lock", ok: true, detail: "available" },
      { name: "protocol", ok: true, detail: "1" },
    ];
    expect(formatDoctorReport(okChecks, { targetDir: "/work", quiet: true, tty: true })).toEqual(
      [],
    );
  });
});

describe("B14-B16 CLI text polish regressions", () => {
  test("B14: formatError indents multiline continuation lines in TTY and plain modes", () => {
    const ttyErr = formatError("First line of error\nSecond detail line\nThird detail line", {
      stream: { isTTY: true },
      palette: createPalette({ depth: "none" }),
    });
    expect(ttyErr).toContain(
      "  ✗ First line of error\n    Second detail line\n    Third detail line",
    );
    expect(ttyErr).not.toContain("\x1b");

    const plainErr = formatError("First line\nSecond line", {
      stream: { isTTY: false },
      palette: createPalette({ depth: "none" }),
    });
    expect(plainErr).toContain("  error: First line\n         Second line");
    expect(plainErr).not.toContain("\x1b");
  });

  test("B15: createSpinner does not pollute non-TTY stdout", () => {
    const out = spyOn(process.stdout, "write").mockReturnValue(true);
    const err = spyOn(process.stderr, "write").mockReturnValue(true);
    const prevOut = process.stdout.isTTY;
    const prevErr = process.stderr.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    try {
      const spinner = createSpinner("Scanning...");
      spinner.update("still scanning");
      spinner.stop();
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: prevOut, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: prevErr, configurable: true });
      out.mockRestore();
      err.mockRestore();
    }
  });

  test("B16: idleLabel distinguishes <1m and <1h instead of clamping to 1h", () => {
    const now = Date.parse("2026-11-28T12:00:00Z");
    expect(idleLabel(now - 20_000, now)).toBe("now");
    expect(idleLabel(now - 60_000, now)).toBe("<1h");
    expect(idleLabel(now - 35 * 60_000, now)).toBe("<1h");
    expect(idleLabel(now - 3_600_000, now)).toBe("1h");
    expect(idleLabel(now - 3 * 86_400_000, now)).toBe("3d");
    expect(idleLabel(undefined, now)).toBe("");
  });

  test("B16: init report pluralizes blocked matches and indents dry-run JSON on TTY", () => {
    const single = formatInitReport(
      {
        targetDir: "/work/app",
        defaults: [
          { pattern: "node_modules", note: "npm/bun install output", count: 2, bytes: 4096 },
        ],
        optIns: [{ pattern: "dist", note: "bundler output", count: 1, bytes: 1024 }],
        blocked: 1,
      },
      { tty: true, palette: createPalette({ depth: "none" }) },
    ).join("\n");
    expect(single).toContain("1 match is git-tracked or project files");
    expect(single).not.toContain("match(es)");

    const multi = formatInitReport(
      { targetDir: "/work/app", defaults: [], optIns: [], blocked: 3 },
      { tty: true, palette: createPalette({ depth: "none" }) },
    ).join("\n");
    expect(multi).toContain("3 matches are git-tracked or project files");

    const ttyJson = formatInitDryRunJson(
      { patterns: [], ignore: [], maxSizeGB: null },
      {
        tty: true,
        palette: createPalette({ depth: "none" }),
      },
    );
    expect(ttyJson[0]).toContain(".sweeprc preview");
    expect(ttyJson[1]).toStartWith("   │ {");

    const plainJson = formatInitDryRunJson(
      { patterns: [], ignore: [], maxSizeGB: null },
      {
        tty: false,
        palette: createPalette({ depth: "none" }),
      },
    );
    expect(JSON.parse(plainJson.join("\n"))).toEqual({ patterns: [], ignore: [], maxSizeGB: null });
  });

  test("stats summary aligns tabular columns and pluralizes properly", () => {
    const lines = formatStatsSummary(
      { sessions: 1, totalDeleted: 13, totalBytesFreed: 143.5 * 1024 * 1024, totalFailed: 1 },
      [
        {
          ts: "2026-11-28T08:04:55Z",
          targetDir: "/work/a",
          deleted: 12,
          bytesFreed: 3.5 * 1024 * 1024,
          failed: 0,
          interrupted: false,
        },
        {
          ts: "2026-11-28T08:05:59Z",
          targetDir: "/work/b",
          deleted: 1,
          bytesFreed: 140 * 1024 * 1024,
          failed: 1,
          interrupted: false,
        },
      ],
      "/var/tmp/config/history.jsonl",
      3,
      { tty: true, columns: 100, palette: createPalette({ depth: "none" }) },
    );
    const text = lines.join("\n");
    expect(text).toContain("across 1 cleanup");
    expect(text).toContain("1 item failed to delete in retained history");
    expect(text).toContain("12 items");
    expect(text).toContain(" 1 item ");
    expect(text).toContain("1 older session");
    expect(text).not.toContain("item(s)");
    expect(text).not.toContain("session(s)");

    // Both target paths start at the exact same column despite different byte & count widths.
    const rowA = lines.find((line) => line.includes("/work/a"))!;
    const rowB = lines.find((line) => line.includes("/work/b"))!;
    expect(rowA.indexOf("/work/a")).toBe(rowB.indexOf("/work/b"));
  });

  test("inspect plan summary formats aligned metadata, risk badges, and relative time", () => {
    const now = Date.parse("2026-11-28T12:00:00Z");
    const lines = formatPlanInfo(
      "/var/tmp/sample-plan.json",
      {
        protocolVersion: "1",
        createdAt: "2026-11-28T11:55:00.000Z",
        targetDir: "/var/tmp/workspace",
        candidateCount: 4,
        selectedCount: 1,
        selectedBytes: 4 * 1024 * 1024,
        estimatedTotalBytes: 6 * 1024 * 1024,
        scannedDirs: 12,
        skippedDirs: 0,
        exact: false,
        kinds: { node_modules: 2, dist: 1, ".turbo": 1 },
        risks: { safe: 2, caution: 1, dangerous: 1 },
      },
      { tty: true, columns: 100, now, palette: createPalette({ depth: "none" }) },
    );
    const text = lines.join("\n");
    expect(text).toContain("◆ sweep inspect");
    expect(text).toContain("5 minutes ago");
    expect(text).toContain("✓ 2 safe");
    expect(text).toContain("! 1 caution");
    expect(text).toContain("✗ 1 dangerous");
    expect(text).toContain("1 item · ~4.0 MiB");
    expect(text).toContain("12 dirs");
    expect(plural(1, "item")).toBe("1 item");
  });

  test("scan report headline shows guarded bytes separately from reclaimable", () => {
    const lines = formatScanReport(
      {
        protocolVersion: "1",
        createdAt: "2026-11-28T12:00:00.000Z",
        targetDir: "/work",
        selectionPolicy: { mode: "default", includeDangerous: false },
        candidates: [
          candidate({
            id: "s1",
            name: "node_modules",
            kind: "node_modules",
            path: "/work/app/node_modules",
            estimatedBytes: 10 * 1024 * 1024,
            riskTier: "safe",
          }),
          candidate({
            id: "d1",
            name: "target",
            kind: "target",
            path: "/work/notes/target",
            estimatedBytes: 2 * 1024 * 1024,
            riskTier: "dangerous",
            selectedByDefault: false,
          }),
        ],
        selectedCandidateIds: ["s1"],
        summary: {
          candidateCount: 2,
          selectedCount: 1,
          estimatedTotalBytes: 12 * 1024 * 1024,
          scannedDirs: 10,
          exact: false,
          riskCounts: { safe: 1, caution: 0, dangerous: 1, blocked: 0 },
        },
      },
      "/work",
      { columns: 100, disk: null, palette: createPalette({ depth: "none" }) },
    );
    const headline = lines.find((line) => line.includes("to reclaim"))!;
    expect(headline).toContain("~10.0 MiB to reclaim");
    expect(headline).toContain("+~2.0 MiB guarded");
  });
});
