import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";

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

function canonicalPath(path: string): string {
  let resolved = path;
  try {
    resolved = realpathSync(path);
  } catch {
    // dangling or unreadable - compare the unresolved path
  }
  return normalizeKey(resolved);
}

/** canonicalPath's normalization without the realpath - the lexical key. */
function normalizeKey(path: string): string {
  const normalized = resolve(path)
    .replace(/^\\\\\?\\/i, "")
    .replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function markSymlinkAliases(candidates: ScanCandidate[]): ScanCandidate[] {
  // Index directory candidates once under BOTH spellings - canonical and
  // lexical (the lexical key covers a dir whose own canonicalize failed and
  // fell back). The old shape was O(symlinks x dirs) with a fresh
  // realpathSync inside the probe: a pnpm monorepo froze the event loop for
  // seconds inside enrichCandidates - unquittable even for Ctrl+C, since
  // signal delivery is event-loop-bound.
  const dirByReal = new Map<string, ScanCandidate>();
  const dirByLexical = new Map<string, ScanCandidate>();
  for (const candidate of candidates) {
    if (candidate.isSymlink || candidate.entryType !== "directory") continue;
    dirByReal.set(canonicalPath(candidate.path), candidate);
    dirByLexical.set(normalizeKey(candidate.path), candidate);
  }

  return candidates.map((candidate) => {
    if (!candidate.isSymlink) {
      return candidate;
    }

    // A link is an alias when its resolved target IS a directory candidate
    // or lives inside one - walk the resolved path's ancestors instead of
    // probing every dir: O(path depth) per symlink.
    const resolved = canonicalPath(candidate.path);
    let hostMatch: ScanCandidate | undefined;
    for (let cursor: string | undefined = resolved; cursor !== undefined; ) {
      const hit = dirByReal.get(cursor) ?? dirByLexical.get(cursor);
      if (hit !== undefined && hit.id !== candidate.id) {
        hostMatch = hit;
        break;
      }
      const parent = dirname(cursor);
      cursor = parent === cursor ? undefined : parent;
    }

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
