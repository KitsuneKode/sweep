import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SELECTION_POLICY,
  IDLE_WINDOW_MS,
  PROTOCOL_VERSION,
  type CandidateKind,
  type RiskTier,
  type ScanCandidate,
  type ScanPlan,
  type WorktreeState,
} from "@kitsunekode/sweep-protocol";
import { formatIdleWindowLabel, summarizeStatus } from "./status.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const GB = 1_000_000_000;

function candidate(
  kind: CandidateKind,
  bytes: number,
  riskTier: RiskTier,
  projectRoot?: string,
  idleDays?: number,
  extra: Partial<
    Pick<ScanCandidate, "bytesKnown" | "worktreeOf" | "worktreeState" | "projectActiveMs">
  > = {},
): ScanCandidate {
  return {
    id: `cand_${kind}_${bytes}_${projectRoot ?? "none"}`,
    path: `${projectRoot ?? "/x"}/${kind}`,
    name: kind,
    kind,
    estimatedBytes: bytes,
    isSymlink: false,
    entryType: "directory",
    riskTier,
    reasons: [],
    selectedByDefault: false,
    ...(projectRoot ? { projectRoot } : {}),
    ...(idleDays !== undefined ? { projectActiveMs: NOW - idleDays * DAY } : {}),
    ...extra,
  } as ScanCandidate;
}

function plan(
  candidates: ScanCandidate[],
  summaryOverrides: Partial<ScanPlan["summary"]> = {},
): ScanPlan {
  return {
    protocolVersion: PROTOCOL_VERSION,
    targetDir: "/p",
    selectionPolicy: DEFAULT_SELECTION_POLICY,
    candidates,
    summary: {
      candidateCount: candidates.length,
      estimatedTotalBytes: 0,
      scannedDirs: 12,
      exact: false,
      selectedCount: 0,
      riskCounts: { safe: 0, caution: 0, dangerous: 0, blocked: 0 },
      ...summaryOverrides,
    },
    selectedCandidateIds: [],
    createdAt: "2026-11-17T00:00:00.000Z",
  };
}

describe("summarizeStatus", () => {
  test("only safe and caution count as space; dangerous and blocked are protected", () => {
    const s = summarizeStatus(
      plan([
        candidate("node_modules", 5 * GB, "caution"),
        candidate(".next", 1 * GB, "safe"),
        candidate("target", 9 * GB, "dangerous"),
        candidate("custom", 2 * GB, "blocked"),
      ]),
      NOW,
    );
    expect([
      s.reclaimableBytes,
      s.safeBytes,
      s.cautionBytes,
      s.protectedCount,
      s.protectedBytes,
    ]).toEqual([6 * GB, 1 * GB, 5 * GB, 2, 11 * GB]);
  });

  test("kinds are ranked by size and counted", () => {
    const s = summarizeStatus(
      plan([
        candidate("target", 2 * GB, "safe"),
        candidate("node_modules", 3 * GB, "safe", "/p/a"),
        candidate("node_modules", 4 * GB, "caution", "/p/b"),
      ]),
      NOW,
    );
    expect(s.kinds).toEqual([
      { kind: "node_modules", bytes: 7 * GB, count: 2 },
      { kind: "target", bytes: 2 * GB, count: 1 },
    ]);
  });

  test("idle means known and old enough; unknown activity is never idle", () => {
    const s = summarizeStatus(
      plan([
        candidate("node_modules", 4 * GB, "safe", "/p/old", 212),
        candidate("target", 2 * GB, "safe", "/p/old", 212),
        candidate("node_modules", 3 * GB, "safe", "/p/fresh", 3),
        candidate("node_modules", 9 * GB, "safe", "/p/unknown"),
        candidate("node_modules", 7 * GB, "dangerous", "/p/guarded", 400),
      ]),
      NOW,
    );
    expect(s.idle).toEqual({
      days: 30,
      windowMs: 30 * DAY,
      windowLabel: "30+ days",
      projects: 1,
      bytes: 6 * GB,
      // Only the old project's kinds: the fresh and unknown ones are not idle,
      // so a bar drawn from these adds up to the headline number.
      kinds: [
        { kind: "node_modules", bytes: 4 * GB, count: 1 },
        { kind: "target", bytes: 2 * GB, count: 1 },
      ],
    });
    expect(s.idle.kinds.reduce((sum, k) => sum + k.bytes, 0)).toBe(s.idle.bytes);
    expect(s.projects).toEqual([
      { name: "old", path: "/p/old", bytes: 6 * GB, idleDays: 212, idleMs: 212 * DAY },
    ]);
  });

  test("carries scan and byte coverage (skippedDirs, bytesPartial, complete)", () => {
    const clean = summarizeStatus(plan([candidate("node_modules", GB, "safe", "/p/a", 40)]), NOW);
    expect(clean.skippedDirs).toBe(0);
    expect(clean.bytesPartial).toBe(false);
    expect(clean.partialByteCount).toBe(0);
    expect(clean.complete).toBe(true);

    const skipped = summarizeStatus(
      plan([candidate("node_modules", GB, "safe", "/p/a", 40)], { skippedDirs: 3 }),
      NOW,
    );
    expect(skipped.skippedDirs).toBe(3);
    expect(skipped.bytesPartial).toBe(false);
    expect(skipped.complete).toBe(false);

    const partial = summarizeStatus(
      plan([
        candidate("node_modules", GB, "safe", "/p/a", 40, { bytesKnown: false }),
        candidate("target", GB, "dangerous", "/p/b", 40, { bytesKnown: false }),
      ]),
      NOW,
    );
    expect(partial.bytesPartial).toBe(true);
    expect(partial.partialByteCount).toBe(1);
    expect(partial.complete).toBe(false);
  });

  test("preserves exact sub-day and fractional idle durations", () => {
    expect(formatIdleWindowLabel(12 * HOUR)).toBe("12+ hours");
    expect(formatIdleWindowLabel(1 * HOUR)).toBe("1+ hour");
    expect(formatIdleWindowLabel(36 * HOUR)).toBe("36+ hours");
    expect(formatIdleWindowLabel(1 * DAY)).toBe("1+ day");
    expect(formatIdleWindowLabel(30 * DAY)).toBe("30+ days");

    const subDay = summarizeStatus(
      plan([
        candidate("node_modules", GB, "safe", "/p/subday", undefined, {
          projectActiveMs: NOW - 14 * HOUR,
        }),
      ]),
      NOW,
      12 * HOUR,
    );
    expect(subDay.idle.windowMs).toBe(12 * HOUR);
    expect(subDay.idle.windowLabel).toBe("12+ hours");
    expect(subDay.idle.projects).toBe(1);
    expect(subDay.projects[0]?.idleMs).toBe(14 * HOUR);
    expect(subDay.projects[0]?.idleDays).toBe(0);
  });

  test("worktree state parity matches D5 (finishedWorktrees vs upstream_gone vs idle)", () => {
    const wt = (name: string, bytes: number, daysAgo: number, state?: WorktreeState) =>
      candidate("node_modules", bytes, "safe", `/p/app/.worktrees/${name}`, daysAgo, {
        worktreeOf: "/p/app",
        ...(state ? { worktreeState: state } : {}),
      });

    const s = summarizeStatus(
      plan([
        wt("merged-quiet", 4 * GB, 3, "merged"),
        wt("merged-old", 2 * GB, 45, "merged"),
        wt("merged-fresh", 1 * GB, 0.2, "merged"),
        wt("gone-recent", 3 * GB, 5, "upstream_gone"),
        wt("gone-old", 5 * GB, 60, "upstream_gone"),
        wt("open-old", 1 * GB, 40),
      ]),
      NOW,
    );

    // Only clean merged worktrees quiet >= 24h enter finishedWorktrees, excluded from idle.
    expect(s.finishedWorktrees.projects).toBe(2);
    expect(s.finishedWorktrees.bytes).toBe(6 * GB);
    expect(s.finishedWorktrees.items.map((item) => item.name)).toEqual([
      "merged-quiet",
      "merged-old",
    ]);
    expect(s.finishedWorktrees.items[0]?.worktreeOf).toBe("/p/app");
    expect(s.finishedWorktrees.items[0]?.worktreeState).toBe("merged");

    // upstream_gone is surfaced separately and never treated as finished.
    expect(s.branchMissingWorktrees).toEqual({ projects: 2, bytes: 8 * GB });

    // Idle includes gone-old and open-old, never double-counting merged-old.
    expect(s.idle.projects).toBe(2);
    expect(s.idle.bytes).toBe(6 * GB);
    expect(s.projects.map((p) => [p.name, p.worktreeState ?? "open"])).toEqual([
      ["gone-old", "upstream_gone"],
      ["open-old", "open"],
    ]);
  });

  test("the window is the caller's and the boundary is inclusive", () => {
    const edge = plan([candidate("node_modules", GB, "safe", "/p/edge", 30)]);
    expect(summarizeStatus(edge, NOW).idle.projects).toBe(1);
    expect(summarizeStatus(edge, NOW, IDLE_WINDOW_MS + DAY).idle.projects).toBe(0);
    expect(summarizeStatus(edge, NOW, 7 * DAY).idle.days).toBe(7);
  });

  test("an empty plan is all zeros", () => {
    const s = summarizeStatus(plan([]), NOW);
    expect(s.reclaimableBytes).toBe(0);
    expect(s.protectedBytes).toBe(0);
    expect(s.kinds).toEqual([]);
    expect(s.idle.projects).toBe(0);
    expect(s.finishedWorktrees.projects).toBe(0);
    expect(s.branchMissingWorktrees.projects).toBe(0);
    expect(s.complete).toBe(true);
    expect(s.scannedDirs).toBe(12);
  });
});
