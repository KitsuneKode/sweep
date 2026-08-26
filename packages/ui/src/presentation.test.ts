import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { formatArtifactRow, relativePath } from "./presentation.js";
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

describe("presentation formatters", () => {
  test("relativePath strips the scan root prefix", () => {
    expect(relativePath("/tmp/project", "/tmp/project/node_modules")).toBe("node_modules");
    expect(relativePath("/tmp/project/", "/tmp/project/node_modules")).toBe("node_modules");
  });

  test("formatArtifactRow is a single dense line", () => {
    const line = formatArtifactRow(candidate(), true, darkTheme);
    expect(line).toContain("●");
    expect(line).toContain("node_modules");
    expect(line).toContain("512 B");
    expect(line).toContain("✓");
    expect(line.startsWith(" ")).toBe(true);
  });
});
