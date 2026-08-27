import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import type { SweepUiSummary } from "./state.js";
import {
  artifactRowWidths,
  buildArtifactRowContent,
  buildGroupHeaderContent,
  buildHeaderStats,
  relativePath,
  splitNameCell,
  truncateScopeLabel,
} from "./presentation.js";
import { darkTheme } from "./theme.js";

function planFixture(): ScanPlan {
  return {
    protocolVersion: "1",
    targetDir: "/tmp/project",
    selectionPolicy: { mode: "default", includeDangerous: false },
    candidates: [],
    summary: {
      candidateCount: 0,
      estimatedTotalBytes: 0,
      scannedDirs: 0,
      exact: false,
      selectedCount: 0,
      riskCounts: { safe: 0, caution: 0, dangerous: 0, blocked: 0 },
    },
    selectedCandidateIds: [],
    createdAt: new Date().toISOString(),
  };
}

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

/**
 * Flatten a StyledText to its visible characters.
 *
 * These assertions used to run against parallel plain-text formatters, which
 * meant the shipping renderer could drift while the tests stayed green. Asserting
 * on the real output keeps the coverage honest.
 */
function plain(text: { chunks: Array<{ text: string }> }): string {
  return text.chunks.map((chunk) => chunk.text).join("");
}

describe("presentation formatters", () => {
  test("relativePath strips the scan root prefix", () => {
    const root = join(tmpdir(), "project");
    const target = join(root, "node_modules");
    expect(relativePath(root, target)).toBe("node_modules");
  });

  test("an artifact row is a single dense line", () => {
    const line = plain(
      buildArtifactRowContent(candidate(), true, false, artifactRowWidths(80), darkTheme),
    );
    expect(line).toContain("●");
    expect(line).toContain("node_modules");
    expect(line).toContain("512 B");
    expect(line).toContain("✓");
    expect(line.startsWith(" ")).toBe(true);
    expect(line.includes("\n")).toBe(false);
  });

  test("the cursor row is railed and queued rows are marked", () => {
    const widths = artifactRowWidths(80);
    expect(plain(buildArtifactRowContent(candidate(), false, true, widths, darkTheme))).toContain(
      "▌",
    );
    expect(plain(buildArtifactRowContent(candidate(), false, false, widths, darkTheme))).toContain(
      "○",
    );
  });

  test("splitNameCell keeps the artifact name and a muted parent path", () => {
    const { nameText, parentText } = splitNameCell("dist", "apps/cli", 24);
    expect(nameText.trim()).toBe("dist");
    expect(parentText.trim()).toBe("apps/cli");
    expect(nameText.length + parentText.length).toBe(24);
  });

  test("an artifact row includes its parent when a scan root is provided", () => {
    const line = plain(
      buildArtifactRowContent(
        candidate({ path: "/tmp/project/apps/cli/dist", name: "dist" }),
        false,
        false,
        artifactRowWidths(80),
        darkTheme,
        "/tmp/project",
      ),
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

  test("a group heading puts bytes next to the count, not in place of the name", () => {
    const line = plain(
      buildGroupHeaderContent(
        {
          kind: "header",
          groupKey: "apps/cli",
          label: "apps/cli/",
          itemCount: 3,
          selectedCount: 0,
          collapsed: false,
          bytes: 1024,
        },
        darkTheme,
        artifactRowWidths(80),
      ),
    );
    expect(line).toContain("apps/cli/");
    expect(line).toContain("3");
    expect(line).toContain("1KB");
  });

  test("a collapsed heading points right and an expanded one points down", () => {
    const header = (collapsed: boolean) =>
      plain(
        buildGroupHeaderContent(
          {
            kind: "header",
            groupKey: "apps/cli",
            label: "apps/cli/",
            itemCount: 3,
            selectedCount: 0,
            collapsed,
            bytes: 1024,
          },
          darkTheme,
          artifactRowWidths(80),
        ),
      );
    expect(header(true).startsWith("▸")).toBe(true);
    expect(header(false).startsWith("▾")).toBe(true);
  });
});

describe("buildHeaderStats queue counts", () => {
  const summary = (over: Partial<SweepUiSummary> = {}): SweepUiSummary => ({
    visibleCount: 10,
    selectedCount: 3,
    selectedBytes: 3072,
    visibleSelectedCount: 3,
    dangerousVisibleCount: 0,
    ...over,
  });

  test("reports the queue plainly when all of it is on screen", () => {
    const line = plain(buildHeaderStats(planFixture(), summary(), darkTheme));
    expect(line).toContain("3 queued");
    expect(line).not.toContain("shown");
  });

  test("says how much of the queue is hidden by the current view", () => {
    // Regression: the header used to count only visible rows, so narrowing the
    // view made a queued deletion look smaller than it was.
    const line = plain(
      buildHeaderStats(planFixture(), summary({ visibleSelectedCount: 1 }), darkTheme),
    );
    expect(line).toContain("3 queued (1 shown)");
  });

  test("stays silent about the queue when nothing is queued", () => {
    const line = plain(
      buildHeaderStats(
        planFixture(),
        summary({ selectedCount: 0, selectedBytes: 0, visibleSelectedCount: 0 }),
        darkTheme,
      ),
    );
    expect(line).not.toContain("queued");
  });
});
