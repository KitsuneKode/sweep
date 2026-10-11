import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";

export const REVIEW_FIXTURES = ["Demo", "Worst", "Empty", "One", "Huge"] as const;
export type ReviewFixture = (typeof REVIEW_FIXTURES)[number];

/** In-memory review data only. No fixture path is created or passed to an engine. */
export function reviewFixture(mode: ReviewFixture): ScanPlan {
  const targetDir = join(tmpdir(), "sweep-review-preview");
  const count = mode === "Empty" ? 0 : mode === "One" ? 1 : mode === "Huge" ? 10000 : 8;
  const parents = [
    "apps/web",
    "東京の成果物/packages/👩🏽‍💻",
    "deployment/customer-feedback-from-enterprise-onboarding",
    "packages/Đặng-Thị-Ngọc-Hân",
    "apps/نور-الهدى",
    "archive/Q3-review-FINAL-revised-v12",
    "packages/a",
    "workspace/👨‍👩‍👧‍👦/e\u0301",
  ];
  const candidates: ScanCandidate[] = Array.from({ length: count }, (_, i) => {
    const worst = mode === "Worst" || mode === "Huge";
    const riskTier = (["safe", "caution", "dangerous", "blocked"] as const)[i % 4]!;
    const name = i % 3 === 0 ? "node_modules" : i % 3 === 1 ? "target" : "dist";
    const parent =
      mode === "Huge"
        ? `${parents[i % parents.length]}/project-${i}`
        : parents[i % parents.length]!;
    return {
      id: `preview_${i}`,
      path: join(targetDir, parent, name),
      name,
      kind: name === "node_modules" ? "node_modules" : name === "target" ? "target" : "build",
      estimatedBytes: worst
        ? [600 * 1024 ** 3, 0, 1, 4096, 1284, 1024 ** 2, 12 * 1024 ** 3, 2048][i % 8]!
        : (i + 1) * 1024 ** 2,
      bytesKnown: !worst || i % 5 !== 0,
      entryType: worst && i === 2 ? "symlink" : "directory",
      isSymlink: worst && i === 2,
      riskTier,
      reasons: worst
        ? [
            "custom-pattern",
            "workspace-stub",
            "Long review reason: generated outputs for customer-feedback-from-enterprise-onboarding need explicit review.",
          ]
        : ["default-pattern"],
      ...(i % 3 === 0 ? {} : { modifiedMs: Date.UTC(2026, 9, 11) - i * 86400000 }),
      selectedByDefault: riskTier === "safe",
    };
  });
  const selectedCandidateIds = candidates
    .filter((candidate) => candidate.selectedByDefault)
    .map((candidate) => candidate.id);
  const riskCounts = { safe: 0, caution: 0, dangerous: 0, blocked: 0 };
  for (const candidate of candidates) riskCounts[candidate.riskTier]++;
  return {
    protocolVersion: "1",
    targetDir,
    selectionPolicy: { mode: "default", includeDangerous: false },
    candidates,
    selectedCandidateIds,
    createdAt: "2026-10-11T00:00:00.000Z",
    summary: {
      candidateCount: count,
      selectedCount: selectedCandidateIds.length,
      estimatedTotalBytes: candidates.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
      scannedDirs: count + 1,
      exact: false,
      riskCounts,
    },
  };
}
