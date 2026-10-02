import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import { planExportName, writePlanExport } from "./plan-export.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sweep-export-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const plan: ScanPlan = {
  protocolVersion: "1",
  targetDir: "/work/app",
  createdAt: "2026-09-30T14:15:03.000Z",
  selectionPolicy: { mode: "default", includeDangerous: false },
  candidates: [],
  selectedCandidateIds: [],
  summary: {
    candidateCount: 0,
    selectedCount: 0,
    estimatedTotalBytes: 0,
    riskCounts: { safe: 0, caution: 0, dangerous: 0, blocked: 0 },
    scannedDirs: 0,
    exact: false,
  },
};

describe("planExportName", () => {
  test("is sortable, local-time, and shell-safe", () => {
    expect(planExportName(new Date(2026, 8, 5, 4, 3, 2))).toBe("sweep-plan-20260905-040302.json");
  });
});

describe("writePlanExport", () => {
  test("writes the plan as JSON and returns its path", () => {
    const written = writePlanExport(plan, dir, new Date(2026, 8, 30, 14, 15, 3));
    expect(written).toBe(join(dir, "sweep-plan-20260930-141503.json"));
    expect(JSON.parse(readFileSync(written, "utf8"))).toEqual(plan);
  });

  test("is readable by the owner only", () => {
    if (process.platform === "win32") return;
    const written = writePlanExport(plan, dir);
    expect(statSync(written).mode & 0o077).toBe(0);
  });

  test("never overwrites an existing file - colliding names get a suffix", () => {
    const when = new Date(2026, 8, 30, 14, 15, 3);
    const first = writePlanExport(plan, dir, when);
    const second = writePlanExport(plan, dir, when);
    const third = writePlanExport(plan, dir, when);
    expect(second).toBe(join(dir, "sweep-plan-20260930-141503-1.json"));
    expect(third).toBe(join(dir, "sweep-plan-20260930-141503-2.json"));
    expect(first).not.toBe(second);
    // All three plans survive - no export silently clobbers another.
    for (const path of [first, second, third]) {
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(plan);
    }
  });
});
