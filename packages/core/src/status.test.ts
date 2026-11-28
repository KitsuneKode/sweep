import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SELECTION_POLICY,
  IDLE_WINDOW_MS,
  PROTOCOL_VERSION,
  type CandidateKind,
  type RiskTier,
  type ScanCandidate,
  type ScanPlan,
} from "@kitsunekode/sweep-protocol";
import { summarizeStatus } from "./status.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const GB = 1_000_000_000;

function candidate(
  kind: CandidateKind,
  bytes: number,
  riskTier: RiskTier,
  projectRoot?: string,
  idleDays?: number,
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
  } as ScanCandidate;
}

function plan(candidates: ScanCandidate[]): ScanPlan {
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
    expect([s.reclaimableBytes, s.safeBytes, s.cautionBytes, s.protectedCount]).toEqual([
      6 * GB,
      1 * GB,
      5 * GB,
      2,
    ]);
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
    expect(s.projects).toEqual([{ name: "old", path: "/p/old", bytes: 6 * GB, idleDays: 212 }]);
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
    expect(s.kinds).toEqual([]);
    expect(s.idle.projects).toBe(0);
    expect(s.scannedDirs).toBe(12);
  });

  test("surfaces uniqueReclaimableBytes alongside apparent reclaimableBytes for hardlinked stores", () => {
    const p = plan([
      { ...candidate("node_modules", 10 * GB, "safe", "/p/a", 40), uniqueBytes: 1 * GB },
      { ...candidate("node_modules", 10 * GB, "safe", "/p/b", 40), uniqueBytes: 1 * GB },
    ]);
    p.summary.estimatedTotalBytes = 20 * GB;
    p.summary.uniqueTotalBytes = 2 * GB;
    const s = summarizeStatus(p, NOW);
    expect(s.reclaimableBytes).toBe(20 * GB);
    expect(s.uniqueReclaimableBytes).toBe(2 * GB);
    expect(s.uniqueBytesPartial).toBeUndefined();
  });

  test("propagates uniqueBytesPartial when bounded hardlink tracking hit its cap", () => {
    const p = plan([
      { ...candidate("node_modules", 10 * GB, "safe", "/p/a", 40), uniqueBytes: 1 * GB },
      { ...candidate("node_modules", 10 * GB, "safe", "/p/b", 40), uniqueBytes: 1 * GB },
    ]);
    p.summary.estimatedTotalBytes = 20 * GB;
    p.summary.uniqueTotalBytes = 2 * GB;
    p.summary.uniqueBytesPartial = true;
    const s = summarizeStatus(p, NOW);
    expect(s.reclaimableBytes).toBe(20 * GB);
    expect(s.uniqueReclaimableBytes).toBe(2 * GB);
    expect(s.uniqueBytesPartial).toBe(true);
  });
});
