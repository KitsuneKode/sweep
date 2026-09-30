import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import type {
  CandidateKind,
  PathFailure,
  RiskTier,
  ScanCandidate,
  ScanEntry,
  ScanPlan,
  ScanResult,
  SelectionPolicy,
} from "@kitsunekode/sweep-protocol";
import {
  candidateKindFromName,
  DEFAULT_SELECTION_POLICY,
  PROTOCOL_VERSION,
} from "@kitsunekode/sweep-protocol";
import {
  enrichCandidates,
  SYMLINK_ALIAS_REASON,
  WORKSPACE_STUB_REASON,
} from "./candidate-insights.js";
import { isPathWithinRoot, pathHasProtectedVcsSegment } from "./guardrails.js";

export function buildPlan(
  targetDir: string,
  result: ScanResult,
  selectionPolicy: SelectionPolicy = DEFAULT_SELECTION_POLICY,
): ScanPlan {
  const candidates = result.entries.map((entry) => toCandidate(entry));

  return applyPlanInsights({
    protocolVersion: PROTOCOL_VERSION,
    targetDir,
    selectionPolicy,
    candidates,
    summary: {
      candidateCount: candidates.length,
      estimatedTotalBytes: result.estimatedTotalBytes,
      scannedDirs: result.scannedDirs,
      // Sparse field: absent means "nothing skipped" (or a pre-field plan).
      // Keeping zero implicit also keeps JS and Rust plans byte-identical -
      // the Rust engine cannot report skips yet.
      ...(result.skippedDirs > 0 ? { skippedDirs: result.skippedDirs } : {}),
      exact: result.exact,
      selectedCount: 0,
      riskCounts: countRiskTiers(candidates),
    },
    selectedCandidateIds: [],
    createdAt: new Date().toISOString(),
  });
}

/** Recompute candidate insights and selection after scan (JS and Rust engines). */
export function applyPlanInsights(plan: ScanPlan): ScanPlan {
  const candidates = normalizeSelectionDefaults(enrichCandidates(plan.candidates));
  const selectedCandidateIds = compileSelectedCandidateIds(candidates, plan.selectionPolicy);
  const riskCounts = countRiskTiers(candidates);

  return {
    ...plan,
    candidates,
    selectedCandidateIds,
    summary: {
      ...plan.summary,
      candidateCount: candidates.length,
      selectedCount: selectedCandidateIds.length,
      riskCounts,
    },
  };
}

function normalizeSelectionDefaults(candidates: ScanCandidate[]): ScanCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    selectedByDefault:
      candidate.riskTier === "safe" &&
      !candidate.reasons.includes(WORKSPACE_STUB_REASON) &&
      !candidate.reasons.includes(SYMLINK_ALIAS_REASON),
  }));
}

export function compileSelectedCandidateIds(
  candidates: ScanCandidate[],
  selectionPolicy: SelectionPolicy,
): string[] {
  return candidates
    .filter((candidate) => shouldSelectCandidate(candidate, selectionPolicy))
    .map((candidate) => candidate.id);
}

export function toCandidate(entry: ScanEntry): ScanCandidate {
  const id = `cand_${hashString(`${entry.path}:${entry.name}`)}`;
  const kind = candidateKindFromName(entry.name);
  const riskTier = inferRiskTier(entry, kind);
  const reasons = inferReasons(entry, kind);

  return {
    ...entry,
    id,
    kind,
    riskTier,
    reasons,
    selectedByDefault: riskTier === "safe",
  };
}

/**
 * Convert one discovered entry into a fully enriched candidate for
 * streaming scans (ids are deterministic, so sized re-upserts match).
 */
export function candidateFromEntry(entry: ScanEntry): ScanCandidate {
  const base = toCandidate(entry);
  const [enriched] = normalizeSelectionDefaults(enrichCandidates([base]));
  return enriched ?? base;
}

export function resolveSelectedCandidates(plan: ScanPlan): ScanCandidate[] {
  const selectedIds = new Set(plan.selectedCandidateIds);
  return plan.candidates.filter((candidate) => selectedIds.has(candidate.id));
}

export function revalidateCandidates(
  candidates: ScanCandidate[],
  targetDir?: string,
): {
  ready: ScanEntry[];
  failedPaths: PathFailure[];
} {
  const ready: ScanEntry[] = [];
  const failedPaths: PathFailure[] = [];

  // Resolve the target once: the lexical containment check alone is not enough,
  // because a directory inside the tree can be swapped for a symlink between
  // scan and apply - rm would then recurse through it outside the target.
  let realTarget: string | undefined;
  if (targetDir) {
    try {
      realTarget = realpathSync(targetDir);
    } catch {
      // Target itself is unreadable - every candidate will fail lstat anyway.
      realTarget = undefined;
    }
  }

  for (const candidate of candidates) {
    if (targetDir && !isPathWithinRoot(candidate.path, targetDir)) {
      failedPaths.push({
        path: candidate.path,
        code: "outside_target",
        error: "candidate path is outside the plan target directory",
      });
      continue;
    }

    try {
      const stat = lstatSync(candidate.path);
      const isSymlink = stat.isSymbolicLink();
      const entryType = isSymlink ? "symlink" : stat.isDirectory() ? "directory" : "file";

      if (isSymlink !== candidate.isSymlink) {
        failedPaths.push({
          path: candidate.path,
          code: "changed_symlink_state",
          error: "candidate type changed since plan creation",
        });
        continue;
      }

      if (entryType !== candidate.entryType) {
        failedPaths.push({
          path: candidate.path,
          code: "changed_entry_type",
          error: "candidate entry type changed since plan creation",
        });
        continue;
      }

      // Symlink candidates are unlinked (the link removed, never followed), so
      // realpath containment is only meaningful for real entries - and only
      // when the target could be resolved above.
      if (!isSymlink && realTarget) {
        const realCandidate = realpathSync(candidate.path);
        if (!isPathWithinRoot(realCandidate, realTarget)) {
          failedPaths.push({
            path: candidate.path,
            code: "outside_target",
            error: "candidate resolves outside the plan target directory",
          });
          continue;
        }
      }

      ready.push(candidate);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failedPaths.push({
        path: candidate.path,
        code: error.includes("ENOENT")
          ? "missing"
          : error.includes("EACCES") || error.includes("EPERM")
            ? "permission_denied"
            : "filesystem_error",
        error,
      });
    }
  }

  return { ready, failedPaths };
}

export function countRiskTiers(candidates: ScanCandidate[]): Record<RiskTier, number> {
  return candidates.reduce<Record<RiskTier, number>>(
    (counts, candidate) => {
      counts[candidate.riskTier] += 1;
      return counts;
    },
    {
      safe: 0,
      caution: 0,
      dangerous: 0,
      blocked: 0,
    },
  );
}

export { candidateKindFromName } from "@kitsunekode/sweep-protocol";

export function inferRiskTier(entry: ScanEntry, kind: CandidateKind): RiskTier {
  if (pathHasProtectedVcsSegment(entry.path)) return "blocked";
  if (entry.isSymlink) return "caution";
  if (kind === "custom") return "dangerous";
  return "safe";
}

export function inferReasons(entry: ScanEntry, kind: CandidateKind): string[] {
  const reasons: string[] = [];
  if (pathHasProtectedVcsSegment(entry.path)) {
    reasons.push("protected-vcs-path");
  }
  if (entry.isSymlink) reasons.push("symlink");
  if (kind === "custom") {
    reasons.push("custom-pattern");
  } else {
    reasons.push("default-pattern");
  }
  return reasons;
}

function shouldSelectCandidate(
  candidate: ScanCandidate,
  selectionPolicy: SelectionPolicy,
): boolean {
  if (candidate.riskTier === "blocked") return false;
  if (candidate.riskTier === "dangerous" && !selectionPolicy.includeDangerous) {
    return false;
  }

  switch (selectionPolicy.mode) {
    case "none":
      return false;
    case "safe":
      return candidate.riskTier === "safe";
    case "all":
      return true;
    case "default":
    default:
      return candidate.selectedByDefault;
  }
}

function hashString(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
