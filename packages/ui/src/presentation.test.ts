import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import {
  artifactRowWidths,
  formatArtifactRow,
  formatArtifactRowPlain,
  formatScanProgressLine,
  relativePath,
  truncateScopeLabel,
} from "./presentation.js";
import { darkTheme } from "./theme.js";

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

import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(line.includes("\n")).toBe(false);
  });

  test("plain artifact rows stay within the computed list width", () => {
    const widths = artifactRowWidths(80);
    const line = formatArtifactRowPlain(candidate({ name: "node_modules" }), true, false, widths);
    expect(line.length).toBeLessThanOrEqual(80);
    expect(line.includes("\n")).toBe(false);
  });

  test("truncateScopeLabel keeps the leaf of a long path", () => {
    expect(truncateScopeLabel("apps/cli/", 14)).toBe("apps/cli/     ");
    expect(truncateScopeLabel("packages/core/src/", 10)).toBe("…core/src/");
    expect(truncateScopeLabel("all scopes", 20).startsWith("all scopes")).toBe(true);
  });

  test("formatScanProgressLine includes dirs when reported", () => {
    expect(formatScanProgressLine(3, 0)).toBe("scanning… 3 found");
    expect(formatScanProgressLine(3, 12)).toBe("scanning… 3 found  ·  12 dirs");
  });
});
