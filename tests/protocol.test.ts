import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  SCAN_EVENT_TYPES,
  type ScanEvent,
  type ScanPlan,
} from "../packages/protocol/src/index.js";

describe("protocol package", () => {
  test("exports the current protocol version", () => {
    expect(PROTOCOL_VERSION).toBe("1");
  });

  test("defines the scan event types needed for streaming scans", () => {
    expect(SCAN_EVENT_TYPES).toEqual([
      "scan_started",
      "candidate_found",
      "candidate_updated",
      "warning",
      "scan_completed",
    ]);
  });

  test("models a plan as explicit selected candidate ids", () => {
    const plan: ScanPlan = {
      protocolVersion: PROTOCOL_VERSION,
      targetDir: "/tmp/project",
      candidates: [
        {
          id: "cand_1",
          path: "/tmp/project/node_modules",
          name: "node_modules",
          kind: "node_modules",
          estimatedBytes: 42,
          isSymlink: false,
          entryType: "directory",
          riskTier: "safe",
          reasons: ["default-pattern"],
          selectedByDefault: true,
        },
      ],
      summary: {
        candidateCount: 1,
        estimatedTotalBytes: 42,
        scannedDirs: 3,
        exact: false,
        selectedCount: 1,
        riskCounts: {
          safe: 1,
          caution: 0,
          dangerous: 0,
          blocked: 0,
        },
      },
      selectedCandidateIds: ["cand_1", "cand_2"],
      createdAt: "2026-05-06T00:00:00.000Z",
    };

    expect(plan.selectedCandidateIds).toHaveLength(2);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.summary.selectedCount).toBe(1);
  });

  test("supports a candidate_found event shape", () => {
    const event: ScanEvent = {
      type: "candidate_found",
      candidate: {
        id: "cand_1",
        path: "/tmp/project/node_modules",
        name: "node_modules",
        kind: "node_modules",
        estimatedBytes: 42,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: true,
      },
    };

    expect(event.type).toBe("candidate_found");
    if (event.type === "candidate_found") {
      expect(event.candidate.id).toBe("cand_1");
      expect(event.candidate.riskTier).toBe("safe");
    }
  });
});
