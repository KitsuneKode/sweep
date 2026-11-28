import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "@kitsunekode/sweep-display";
import { relativePath } from "./presentation.js";

export interface ConfirmPreviewItem {
  path: string;
  bytes: number;
  riskTier: ScanCandidate["riskTier"];
  isSymlink: boolean;
  bytesKnown?: boolean | undefined;
}

const TIER_RANK = { dangerous: 3, caution: 2, safe: 1, blocked: 0 } as const;

/**
 * The last gate names paths, not a count. Dangerous rows lead, then the
 * largest of what's left, so a small risky folder is not hidden behind
 * three huge safe ones. Blocked rows never appear: they cannot be removed.
 */
export function rankConfirmPreviewItems(
  candidates: readonly ScanCandidate[],
  targetDir: string,
  limit = 3,
): ConfirmPreviewItem[] {
  const top: ScanCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.riskTier === "blocked") continue;
    const index = top.findIndex(
      (other) =>
        TIER_RANK[candidate.riskTier] > TIER_RANK[other.riskTier] ||
        (TIER_RANK[candidate.riskTier] === TIER_RANK[other.riskTier] &&
          candidate.estimatedBytes > other.estimatedBytes),
    );
    top.splice(index < 0 ? top.length : index, 0, candidate);
    if (top.length > limit) top.pop();
  }
  return top.map((candidate) => ({
    path: sanitizeTerminalText(relativePath(targetDir, candidate.path)),
    bytes: candidate.estimatedBytes,
    riskTier: candidate.riskTier,
    isSymlink: candidate.isSymlink,
    ...(candidate.bytesKnown !== undefined ? { bytesKnown: candidate.bytesKnown } : {}),
  }));
}

/** Legacy plain-text rows kept for tests and older callers. */
export function rankConfirmPreview(
  candidates: readonly ScanCandidate[],
  targetDir: string,
  limit = 3,
): string[] {
  return rankConfirmPreviewItems(candidates, targetDir, limit).map(
    (item) =>
      `${item.riskTier}${item.isSymlink ? " · link only" : ""} · ${item.bytesKnown === false ? "~" : ""}${formatBytes(item.bytes)} · ${item.path}`,
  );
}
