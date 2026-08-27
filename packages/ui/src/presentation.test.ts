import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import {
  artifactRowWidths,
  formatArtifactRow,
  formatArtifactRowPlain,
  formatGroupHeaderRow,
  formatScanProgressLine,
  relativePath,
  splitNameCell,
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

  test("splitNameCell keeps the artifact name and a muted parent path", () => {
    const { nameText, parentText } = splitNameCell("dist", "apps/cli", 24);
    expect(nameText.trim()).toBe("dist");
    expect(parentText.trim()).toBe("apps/cli");
    expect(nameText.length + parentText.length).toBe(24);
  });

  test("formatArtifactRowPlain includes the parent when a scan root is provided", () => {
    const widths = artifactRowWidths(80);
    const line = formatArtifactRowPlain(
      candidate({ path: "/tmp/project/apps/cli/dist", name: "dist" }),
      false,
      false,
      widths,
      "/tmp/project",
    );
    expect(line).toContain("dist");
    expect(line).toContain("apps/cli");
    expect(line.includes("\n")).toBe(false);
  });

  test("truncateScopeLabel keeps the last two path segments", () => {
    expect(truncateScopeLabel("apps/cli/", 14)).toBe("apps/cli/     ");
    expect(truncateScopeLabel("packages/core/src/", 10)).toBe("core/src/ ");
    expect(truncateScopeLabel("all scopes", 20).startsWith("all scopes")).toBe(true);
  });

  test("truncateScopeLabel middle-ellipsizes short phrases instead of chopping the start", () => {
    const clipped = truncateScopeLabel("project root", 11);
    expect(clipped).toHaveLength(11);
    expect(clipped.startsWith("…")).toBe(false);
    expect(clipped).toContain("…");
    expect(clipped).toContain("root");
  });

  test("formatGroupHeaderRow puts bytes next to the count, not in place of the name", () => {
    const line = formatGroupHeaderRow({
      kind: "header",
      groupKey: "apps/cli",
      label: "apps/cli/",
      itemCount: 3,
      selectedCount: 0,
      collapsed: false,
      bytes: 1024,
    });
    expect(line).toContain("apps/cli/");
    expect(line).toContain("3");
    expect(line).toContain("1KB");
  });

  test("formatScanProgressLine includes dirs when reported", () => {
    expect(formatScanProgressLine(3, 0)).toBe("scanning… 3 found");
    expect(formatScanProgressLine(3, 12)).toBe("scanning… 3 found  ·  12 dirs");
  });
});
