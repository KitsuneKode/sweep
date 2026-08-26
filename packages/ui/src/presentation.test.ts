import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import {
  artifactRowWidths,
  buildMeter,
  buildRiskTally,
  buildSidebarLine,
  formatArtifactRow,
  relativePath,
} from "./presentation.js";
import { darkTheme } from "./theme.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

function candidate(overrides: Partial<ScanCandidate> = {}): ScanCandidate {
  return {
    id: "cand_1",
    path: "/tmp/project/node_modules",
    name: "node_modules",
    kind: "node_modules",
    estimatedBytes: 512,
    isSymlink: false,
    entryType: "directory",
    riskTier: "safe",
    reasons: ["default-pattern"],
    selectedByDefault: true,
    ...overrides,
  };
}

describe("presentation formatters", () => {
  test("relativePath strips the scan root prefix", () => {
    const root = join(tmpdir(), "project");
    const target = join(root, "node_modules");
    expect(relativePath(root, target)).toBe("node_modules");
  });

  test("formatArtifactRow is a single dense line", () => {
    const line = formatArtifactRow(candidate(), true, darkTheme);
    expect(line).toContain("●");
    expect(line).toContain("node_modules");
    expect(line).toContain("512 B");
    expect(line).toContain("✓");
    expect(line.startsWith(" ")).toBe(true);
  });

  test("artifactRowWidths adjusts nameWidth based on listWidth", () => {
    const narrow = artifactRowWidths(50);
    const wide = artifactRowWidths(120);
    expect(narrow.nameWidth).toBeGreaterThanOrEqual(12);
    expect(wide.nameWidth).toBeGreaterThan(narrow.nameWidth);
    expect(narrow.sizeWidth).toBe(9);
    expect(wide.sizeWidth).toBe(9);
  });

  test("buildSidebarLine truncates with maxLabelWidth", () => {
    const longLabel = "very-long-scope-directory-name";
    const line14 = buildSidebarLine(longLabel, 5, 1024, false, 3, 7, darkTheme, 0, 14);
    const str14 = line14.chunks.map((c) => c.text).join("");
    expect(str14).toContain("…");

    const line40 = buildSidebarLine(longLabel, 5, 1024, false, 3, 7, darkTheme, 0, 40);
    const str40 = line40.chunks.map((c) => c.text).join("");
    expect(str40).toContain(longLabel);
  });

  test("buildMeter renders proportional bar", () => {
    const emptyMeter = buildMeter(0, 100, 10, darkTheme);
    const fullMeter = buildMeter(100, 100, 10, darkTheme);
    const halfMeter = buildMeter(50, 100, 10, darkTheme);

    const emptyText = emptyMeter.chunks.map((c) => c.text).join("");
    const fullText = fullMeter.chunks.map((c) => c.text).join("");
    const halfText = halfMeter.chunks.map((c) => c.text).join("");

    expect(emptyText).toBe("░".repeat(10));
    expect(fullText).toBe("█".repeat(10));
    expect(halfText).toContain("█");
    expect(halfText).toContain("░");
  });

  test("buildRiskTally formats selected bytes vs nothing selected", () => {
    const emptySummary = {
      visibleCount: 10,
      selectedCount: 0,
      selectedBytes: 0,
      dangerousVisibleCount: 0,
    };
    const activeSummary = {
      visibleCount: 10,
      selectedCount: 3,
      selectedBytes: 1024 * 1024 * 50,
      dangerousVisibleCount: 0,
    };

    const empty = buildRiskTally(emptySummary, darkTheme);
    const active = buildRiskTally(activeSummary, darkTheme);

    expect(empty.chunks.map((c) => c.text).join("")).toContain("nothing selected");
    expect(active.chunks.map((c) => c.text).join("")).toContain("50.0 MB");
  });
});
