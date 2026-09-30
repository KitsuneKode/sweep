import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { allocateBarCells, buildInsights } from "./insights.js";

const NOW = Date.UTC(2026, 8, 30);
const DAY = 24 * 60 * 60 * 1000;

function candidate(overrides: Partial<ScanCandidate>): ScanCandidate {
  return {
    id: "c",
    path: "/p/node_modules",
    name: "node_modules",
    kind: "node_modules",
    estimatedBytes: 100,
    isSymlink: false,
    entryType: "directory",
    riskTier: "safe",
    reasons: [],
    selectedByDefault: true,
    ...overrides,
  };
}

describe("buildInsights", () => {
  test("totals bytes per tier in reading order and omits empty tiers", () => {
    const insights = buildInsights(
      [
        candidate({ id: "a", riskTier: "dangerous", estimatedBytes: 10 }),
        candidate({ id: "b", riskTier: "safe", estimatedBytes: 200 }),
        candidate({ id: "c", riskTier: "safe", estimatedBytes: 50 }),
      ],
      NOW,
    );
    expect(insights.tiers).toEqual([
      { tier: "safe", bytes: 250, count: 2 },
      { tier: "dangerous", bytes: 10, count: 1 },
    ]);
    expect(insights.totalBytes).toBe(260);
  });

  test("counts only artifacts untouched for 30 days or more as stale", () => {
    const insights = buildInsights(
      [
        candidate({ id: "old", estimatedBytes: 500, modifiedMs: NOW - 90 * DAY }),
        candidate({ id: "edge", estimatedBytes: 40, modifiedMs: NOW - 30 * DAY }),
        candidate({ id: "fresh", estimatedBytes: 300, modifiedMs: NOW - 2 * DAY }),
      ],
      NOW,
    );
    expect(insights.stale).toEqual({ bytes: 540, count: 2 });
    expect(insights.ageKnown).toBe(true);
  });

  test("blocked artifacts are never reclaimable, so never stale", () => {
    const insights = buildInsights(
      [candidate({ riskTier: "blocked", estimatedBytes: 999, modifiedMs: NOW - 400 * DAY })],
      NOW,
    );
    expect(insights.stale).toEqual({ bytes: 0, count: 0 });
  });

  test("without any mtime the stale figure is reported as unknown, not zero", () => {
    const insights = buildInsights([candidate({})], NOW);
    expect(insights.ageKnown).toBe(false);
  });
});

describe("allocateBarCells", () => {
  const tier = (bytes: number) => ({ tier: "safe" as const, bytes, count: 1 });

  test("always fills exactly the requested width", () => {
    for (const width of [4, 10, 25, 31]) {
      const cells = allocateBarCells([tier(700), tier(200), tier(100)], width);
      expect(cells.reduce((a, b) => a + b, 0)).toBe(width);
    }
  });

  test("a tiny tier still gets one visible cell", () => {
    const cells = allocateBarCells([tier(1_000_000), tier(1)], 20);
    expect(cells).toEqual([19, 1]);
  });

  test("with fewer cells than tiers the largest tiers keep theirs", () => {
    expect(allocateBarCells([tier(10), tier(500), tier(300)], 2)).toEqual([0, 1, 1]);
  });

  test("nothing to draw yields no cells", () => {
    expect(allocateBarCells([tier(0)], 10)).toEqual([0]);
    expect(allocateBarCells([tier(5)], 0)).toEqual([0]);
  });
});
