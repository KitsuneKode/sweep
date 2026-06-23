import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import {
  enrichCandidates,
  SYMLINK_ALIAS_REASON,
  WORKSPACE_STUB_REASON,
} from "./candidate-insights.js";

function candidate(
  overrides: Partial<ScanCandidate> & Pick<ScanCandidate, "id" | "path" | "name">,
): ScanCandidate {
  return {
    estimatedBytes: 0,
    isSymlink: false,
    entryType: "directory",
    kind: "node_modules",
    riskTier: "safe",
    reasons: ["default-pattern"],
    selectedByDefault: true,
    ...overrides,
  };
}

describe("enrichCandidates", () => {
  test("marks tiny peer node_modules as workspace stubs when a primary install exists", () => {
    const root = candidate({
      id: "root",
      path: "/repo/node_modules",
      name: "node_modules",
      estimatedBytes: 200_000_000,
    });
    const stub = candidate({
      id: "stub",
      path: "/repo/apps/cli/node_modules",
      name: "node_modules",
      estimatedBytes: 600,
    });

    const [enrichedRoot, enrichedStub] = enrichCandidates([root, stub]);

    expect(enrichedRoot?.selectedByDefault).toBe(true);
    expect(enrichedStub?.reasons).toContain(WORKSPACE_STUB_REASON);
    expect(enrichedStub?.selectedByDefault).toBe(false);
    expect(enrichedStub?.riskTier).toBe("caution");
  });

  test("does not mark workspace stubs when no primary node_modules exceeds the threshold", () => {
    const left = candidate({
      id: "left",
      path: "/repo/a/node_modules",
      name: "node_modules",
      estimatedBytes: 10_000,
    });
    const right = candidate({
      id: "right",
      path: "/repo/b/node_modules",
      name: "node_modules",
      estimatedBytes: 8_000,
    });

    const enriched = enrichCandidates([left, right]);
    expect(enriched.every((entry) => !entry.reasons.includes(WORKSPACE_STUB_REASON))).toBe(true);
  });

  test("marks symlink entries that resolve inside another candidate", () => {
    const root = mkdtempSync("/tmp/sweep-insights-");
    try {
      mkdirSync(join(root, "dist-target"));
      symlinkSync(join(root, "dist-target"), join(root, "target"));

      const host = candidate({
        id: "host",
        path: join(root, "dist-target"),
        name: "dist-target",
        estimatedBytes: 12,
        kind: "custom",
      });
      const alias = candidate({
        id: "alias",
        path: join(root, "target"),
        name: "target",
        estimatedBytes: 0,
        isSymlink: true,
        entryType: "symlink",
        kind: "target",
        riskTier: "caution",
        reasons: ["symlink", "default-pattern"],
      });

      const enriched = enrichCandidates([host, alias]);
      const enrichedAlias = enriched.find((entry) => entry.id === "alias");

      expect(enrichedAlias?.reasons).toContain(SYMLINK_ALIAS_REASON);
      expect(enrichedAlias?.selectedByDefault).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
