import { realpathSync } from "node:fs";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { isPathWithinRoot } from "./guardrails.js";

/** Reason tag for hoisted workspace `node_modules` stubs (Bun/npm symlinks). */
export const WORKSPACE_STUB_REASON = "workspace-stub";

/** Reason tag when a symlink entry resolves inside another candidate. */
export const SYMLINK_ALIAS_REASON = "symlink-alias";

/** Max bytes for a peer `node_modules` to be treated as a workspace stub. */
export const WORKSPACE_STUB_MAX_BYTES = 1024 * 1024;

/**
 * Refine scan candidates after pattern matching: detect workspace stubs and symlink
 * aliases so default selection targets reclaimable primary copies.
 */
export function enrichCandidates(candidates: ScanCandidate[]): ScanCandidate[] {
  let enriched = markSymlinkAliases(candidates);
  enriched = markWorkspaceStubs(enriched);
  return enriched;
}

export function isWorkspaceStub(candidate: ScanCandidate): boolean {
  return candidate.reasons.includes(WORKSPACE_STUB_REASON);
}

function markSymlinkAliases(candidates: ScanCandidate[]): ScanCandidate[] {
  const directoryCandidates = candidates
    .filter((c) => !c.isSymlink && c.entryType === "directory")
    .map((c) => {
      let realPath = c.path;
      try {
        realPath = realpathSync(c.path);
      } catch {
        // fallback
      }
      return { candidate: c, realPath };
    });

  return candidates.map((candidate) => {
    if (!candidate.isSymlink) {
      return candidate;
    }

    let resolved: string | null = null;
    try {
      resolved = realpathSync(candidate.path);
    } catch {
      return candidate;
    }

    const hostMatch = directoryCandidates.find(
      ({ candidate: other, realPath }) =>
        other.id !== candidate.id &&
        (resolved === realPath ||
          resolved === other.path ||
          isPathWithinRoot(resolved, realPath) ||
          isPathWithinRoot(resolved, other.path)),
    );

    if (!hostMatch) {
      return candidate;
    }

    return patchCandidate(candidate, {
      reasons: uniqueReasons([...candidate.reasons, SYMLINK_ALIAS_REASON]),
      selectedByDefault: false,
      riskTier: "caution",
    });
  });
}

function markWorkspaceStubs(candidates: ScanCandidate[]): ScanCandidate[] {
  const nodeModules = candidates.filter(
    (candidate) => candidate.name === "node_modules" && candidate.entryType === "directory",
  );

  if (nodeModules.length <= 1) {
    return candidates;
  }

  const sorted = [...nodeModules].sort((left, right) => right.estimatedBytes - left.estimatedBytes);
  const primary = sorted[0];
  if (!primary || primary.estimatedBytes < WORKSPACE_STUB_MAX_BYTES) {
    return candidates;
  }

  const stubIds = new Set(
    sorted
      .slice(1)
      .filter((candidate) => candidate.estimatedBytes <= WORKSPACE_STUB_MAX_BYTES)
      .map((candidate) => candidate.id),
  );

  if (stubIds.size === 0) {
    return candidates;
  }

  return candidates.map((candidate) => {
    if (!stubIds.has(candidate.id)) {
      return candidate;
    }

    return patchCandidate(candidate, {
      reasons: uniqueReasons([...candidate.reasons, WORKSPACE_STUB_REASON]),
      selectedByDefault: false,
      riskTier: candidate.riskTier === "safe" ? "caution" : candidate.riskTier,
    });
  });
}

function patchCandidate(
  candidate: ScanCandidate,
  patch: Pick<ScanCandidate, "reasons" | "selectedByDefault" | "riskTier">,
): ScanCandidate {
  return { ...candidate, ...patch };
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons)];
}
