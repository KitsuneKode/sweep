import { describe, expect, test } from "bun:test";
import type { ScanPlan, ScanResult } from "@kitsunekode/sweep-protocol";
import { DEFAULT_CONFIG } from "@kitsunekode/sweep-core/config";
import { runInteractiveCleanup } from "./interactive-cleanup.js";

function createPlan(targetDir: string): ScanPlan {
  return {
    protocolVersion: "1",
    targetDir,
    selectionPolicy: { mode: "default", includeDangerous: false },
    candidates: [
      {
        id: "cand_1",
        path: `${targetDir}/node_modules`,
        name: "node_modules",
        kind: "node_modules",
        estimatedBytes: 1024,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: true,
      },
    ],
    summary: {
      candidateCount: 1,
      estimatedTotalBytes: 1024,
      scannedDirs: 1,
      exact: false,
      selectedCount: 1,
      riskCounts: { safe: 1, caution: 0, dangerous: 0, blocked: 0 },
    },
    selectedCandidateIds: ["cand_1"],
    createdAt: new Date().toISOString(),
  };
}

describe("runInteractiveCleanup", () => {
  test("rescan then apply completes without executing delete in dry-run", async () => {
    const targetDir = "/tmp/sweep-orchestration-test";
    let reviewCalls = 0;
    const plan = createPlan(targetDir);
    const result: ScanResult = {
      entries: plan.candidates.map((candidate) => ({
        path: candidate.path,
        name: candidate.name,
        estimatedBytes: candidate.estimatedBytes,
        isSymlink: candidate.isSymlink,
        entryType: candidate.entryType,
      })),
      estimatedTotalBytes: plan.summary.estimatedTotalBytes,
      scannedDirs: plan.summary.scannedDirs,
      exact: plan.summary.exact,
    };

    const outcome = await runInteractiveCleanup(
      {
        targetDir,
        scanConfig: DEFAULT_CONFIG,
        projectConfig: DEFAULT_CONFIG,
        selectionPolicy: { mode: "default", includeDangerous: false },
        engine: "js",
        dryRun: true,
        review: async () => {
          reviewCalls += 1;
          if (reviewCalls === 1) {
            return { type: "rescan", disabledPatterns: ["dist"], extraPatterns: [] };
          }
          return { type: "apply", plan };
        },
      },
      {
        scan: async () => ({ plan, result }),
        deletePlan: async () => {
          throw new Error("delete should not run in dry-run");
        },
      },
    );

    expect(reviewCalls).toBe(2);
    expect(outcome.type).toBe("dry_run");
  });
});
