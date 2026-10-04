import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type {
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
import { catalogMatchFor } from "./catalog.js";
import { identityFromStat, sameFilesystemIdentity } from "./filesystem-identity.js";
import {
  GuardrailError,
  hasCanonicalPathSpelling,
  isPathWithinRoot,
  isSameResolvedPath,
  pathHasProtectedVcsSegment,
} from "./guardrails.js";

export function buildPlan(
  targetDir: string,
  result: ScanResult,
  selectionPolicy: SelectionPolicy = DEFAULT_SELECTION_POLICY,
): ScanPlan {
  const candidates = result.entries.map((entry) => toCandidate(entry));

  return applyPlanInsights({
    protocolVersion: PROTOCOL_VERSION,
    targetDir,
    targetIdentity: result.targetIdentity,
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
  const riskTier = inferRiskTier(entry);
  const reasons = inferReasons(entry);

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
  const known = new Set(plan.candidates.map((candidate) => candidate.id));
  if (known.size !== plan.candidates.length || [...selectedIds].some((id) => !known.has(id))) {
    throw new GuardrailError("Plan has duplicate candidate IDs or unknown selected IDs");
  }
  return plan.candidates.filter((candidate) => selectedIds.has(candidate.id));
}

export function revalidateCandidates(
  candidates: ScanCandidate[],
  targetDir?: string,
  isCancelled?: () => boolean,
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
    // Rust parity: a cancel during revalidation stops the walk - candidates
    // never reached stay unattempted instead of reporting phantom failures.
    if (isCancelled?.()) break;
    if (targetDir && !isPathWithinRoot(candidate.path, targetDir)) {
      failedPaths.push({
        path: candidate.path,
        code: "outside_target",
        error: "candidate path is outside the plan target directory",
      });
      continue;
    }

    // A plan file is untrusted input: the riskTier field is attacker-controlled,
    // so safety classifications are re-derived from the path here. The scanner
    // never emits the target root itself or anything inside VCS metadata, so a
    // plan that selects them was hand-made. Case-insensitive filesystems make
    // "/TMP/PROJ" the same directory as "/tmp/proj", so compare case-folded
    // where the platform does.
    if (targetDir && isSameResolvedPath(candidate.path, targetDir)) {
      failedPaths.push({
        path: candidate.path,
        code: "protected_path",
        error: "candidate path is the plan target directory itself",
      });
      continue;
    }
    // A path spelling normalize() would rewrite (or a trailing separator,
    // which makes lstat follow a leaf symlink) can never be a scanner
    // product - treat it as a failed entry, never as something to delete.
    // Runs after the semantic root checks so "is the target" still reports
    // protected_path; must run before the first leaf-resolving syscall.
    if (!hasCanonicalPathSpelling(candidate.path)) {
      failedPaths.push({
        path: candidate.path,
        code: "filesystem_error",
        error: "candidate path is not in canonical form",
      });
      continue;
    }
    if (pathHasProtectedVcsSegment(candidate.path)) {
      failedPaths.push({
        path: candidate.path,
        code: "protected_path",
        error: "candidate path is inside protected VCS metadata",
      });
      continue;
    }

    try {
      const stat = lstatSync(candidate.path, { bigint: true });
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

      // Unlinking still follows ancestor directories. Validate the real parent
      // for every entry, including links, without following the leaf itself.
      if (realTarget) {
        const realParent = realpathSync(dirname(candidate.path));
        if (!isPathWithinRoot(realParent, realTarget) || pathHasProtectedVcsSegment(realParent)) {
          failedPaths.push({
            path: candidate.path,
            code: isPathWithinRoot(realParent, realTarget) ? "protected_path" : "outside_target",
            error: "candidate parent resolves outside the target or inside protected VCS metadata",
          });
          continue;
        }
      }

      // Symlink candidates are unlinked (the link removed, never followed), so
      // realpath containment is only meaningful for real entries - and only
      // when the target could be resolved above.
      if (!isSymlink && realTarget) {
        const realCandidate = realpathSync(candidate.path);
        // Canonical equality means the candidate IS the target root spelled
        // differently (case-variant, symlinked parent) - never deletable.
        if (isSameResolvedPath(realCandidate, realTarget)) {
          failedPaths.push({
            path: candidate.path,
            code: "protected_path",
            error: "candidate path resolves to the plan target directory itself",
          });
          continue;
        }
        if (!isPathWithinRoot(realCandidate, realTarget)) {
          failedPaths.push({
            path: candidate.path,
            code: "outside_target",
            error: "candidate resolves outside the plan target directory",
          });
          continue;
        }
        // A symlinked ancestor can place a lexical-clean path inside VCS
        // metadata (sub -> repo/.git): check the canonical path too.
        if (pathHasProtectedVcsSegment(realCandidate)) {
          failedPaths.push({
            path: candidate.path,
            code: "protected_path",
            error: "candidate resolves inside protected VCS metadata",
          });
          continue;
        }
      }

      if (!sameFilesystemIdentity(candidate.identity, identityFromStat(stat))) {
        failedPaths.push({
          path: candidate.path,
          code: "filesystem_error",
          error: "candidate identity is missing or changed since scan; scan again",
        });
        continue;
      }
      ready.push(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const error = err instanceof Error ? err.message : String(err);
      failedPaths.push({
        path: candidate.path,
        code:
          code === "ENOENT"
            ? "missing"
            : code === "EACCES" || code === "EPERM"
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

export function inferRiskTier(entry: ScanEntry): RiskTier {
  if (pathHasProtectedVcsSegment(entry.path)) return "blocked";
  if (entry.isSymlink) return "caution";
  // Only names a shipping-default pattern covers earn the safe tier. Opt-in
  // catalog names (dist, build, out, coverage, ...) are dangerous for the same
  // reason they are opt-in - the name can hold authored files. Enabling a
  // pattern consents to scanning, never to pre-selection.
  return catalogMatchFor(entry.name) === "default" ? "safe" : "dangerous";
}

export function inferReasons(entry: ScanEntry): string[] {
  const reasons: string[] = [];
  if (pathHasProtectedVcsSegment(entry.path)) {
    reasons.push("protected-vcs-path");
  }
  if (entry.isSymlink) reasons.push("symlink");
  const match = catalogMatchFor(entry.name);
  if (match === "default") {
    reasons.push("default-pattern");
  } else if (match === "opt-in") {
    reasons.push("opt-in-pattern");
  } else {
    reasons.push("custom-pattern");
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
