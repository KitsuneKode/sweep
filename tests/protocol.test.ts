import { describe, expect, test } from "bun:test";
import {
  APPLY_REPORT_SCHEMA,
  FAILURE_REASON_CODES,
  DEFAULT_SELECTION_POLICY,
  PROTOCOL_VERSION,
  SCAN_PLAN_SCHEMA,
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
      selectionPolicy: DEFAULT_SELECTION_POLICY,
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

  test("exports a default selection policy for plan compilation", () => {
    expect(DEFAULT_SELECTION_POLICY).toEqual({
      mode: "default",
      includeDangerous: false,
    });
  });

  test("exports stable failure reason codes for engine parity", () => {
    expect(FAILURE_REASON_CODES).toEqual([
      "missing",
      "changed_symlink_state",
      "changed_entry_type",
      "permission_denied",
      "busy",
      "filesystem_error",
    ]);
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

  test("exports JSON Schemas for scan plans and apply reports", () => {
    expect(SCAN_PLAN_SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(SCAN_PLAN_SCHEMA.title).toBe("ScanPlan");
    expect(SCAN_PLAN_SCHEMA.properties.selectionPolicy).toBeDefined();
    expect(SCAN_PLAN_SCHEMA.properties.summary).toBeDefined();
    expect(APPLY_REPORT_SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(APPLY_REPORT_SCHEMA.title).toBe("ApplyReport");
    expect(APPLY_REPORT_SCHEMA.properties.failedPaths).toBeDefined();
  });
});
