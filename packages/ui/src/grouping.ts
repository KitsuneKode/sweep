import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { relativePath } from "./presentation.js";

export interface ArtifactScopeGroup {
  /** Stable sort key — empty string means scan root. */
  key: string;
  /** Human label for the scope, e.g. `project root` or `apps/cli/`. */
  label: string;
  candidateIds: string[];
}

/**
 * Keep the scope sidebar scannable. Deep unique parents (worktrees, nested
 * packages) fold into a shared prefix once this many groups would appear.
 */
export const MAX_SCOPE_GROUPS = 24;

export interface GroupScopeOptions {
  /**
   * Collapse deepest unique parents until this many groups remain.
   * The artifact list passes `Infinity` so each parent stays a heading.
   */
  maxGroups?: number;
}

/** Classify artifacts by the directory they live under relative to the scan root. */
export function groupCandidatesByScope(
  targetDir: string,
  candidates: ScanCandidate[],
  compareItems?: (a: ScanCandidate, b: ScanCandidate) => number,
  options?: GroupScopeOptions,
): ArtifactScopeGroup[] {
  const buckets = new Map<string, { label: string; ids: string[] }>();
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  for (const candidate of candidates) {
    const relative = relativePath(targetDir, candidate.path).replaceAll("\\", "/");
    const segments = relative.split("/").filter((segment) => segment.length > 0);
    const key = segments.length <= 1 ? "" : segments.slice(0, -1).join("/");
    const label = labelForKey(key);

    const bucket = buckets.get(key) ?? { label, ids: [] };
    bucket.ids.push(candidate.id);
    buckets.set(key, bucket);
  }

  const maxGroups = options?.maxGroups ?? MAX_SCOPE_GROUPS;
  const collapsed = collapseDeepestScopes(buckets, maxGroups);

  return [...collapsed.entries()]
    .sort(([left], [right]) => compareScopeKeys(left, right))
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      candidateIds: bucket.ids.sort((leftId, rightId) => {
        if (compareItems) {
          const left = byId.get(leftId);
          const right = byId.get(rightId);
          if (left && right) return compareItems(left, right);
        }
        const leftName = byId.get(leftId)?.name ?? "";
        const rightName = byId.get(rightId)?.name ?? "";
        return leftName.localeCompare(rightName);
      }),
    }));
}

export function labelForKey(key: string): string {
  return key.length === 0 ? "project root" : `${key}/`;
}

/** Drop the last path segment; empty string stays at the scan root. */
export function parentScopeKey(key: string): string {
  if (key.length === 0) return "";
  const slash = key.lastIndexOf("/");
  return slash === -1 ? "" : key.slice(0, slash);
}

export function scopeDepth(key: string): number {
  if (key.length === 0) return 0;
  return key.split("/").filter((segment) => segment.length > 0).length;
}

/**
 * Fold the deepest unique parents first so a noisy tree (worktrees, nested
 * caches) collapses without merging shallow packages like `apps/cli`.
 */
export function collapseDeepestScopes(
  buckets: Map<string, { label: string; ids: string[] }>,
  maxGroups: number,
): Map<string, { label: string; ids: string[] }> {
  let current = buckets;
  while (current.size > maxGroups) {
    let deepest = 0;
    for (const key of current.keys()) {
      deepest = Math.max(deepest, scopeDepth(key));
    }
    if (deepest <= 1) break;

    const next = new Map<string, { label: string; ids: string[] }>();
    let shortened = false;
    for (const [key, bucket] of current) {
      const collapsedKey = scopeDepth(key) >= deepest ? parentScopeKey(key) : key;
      if (collapsedKey !== key) shortened = true;
      const existing = next.get(collapsedKey);
      if (existing) {
        existing.ids.push(...bucket.ids);
      } else {
        next.set(collapsedKey, {
          label: labelForKey(collapsedKey),
          ids: [...bucket.ids],
        });
      }
    }
    if (!shortened) break;
    current = next;
  }
  return current;
}

function compareScopeKeys(left: string, right: string): number {
  if (left.length === 0) return -1;
  if (right.length === 0) return 1;
  return left.localeCompare(right);
}
