import type { RiskTier, ScanCandidate } from "@kitsunekode/sweep-protocol";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long an artifact must sit untouched to count as stale. */
export const STALE_AFTER_DAYS = 30;

/** Tiers in the order they read: reassuring first, alarming last. */
export const RISK_ORDER: readonly RiskTier[] = ["safe", "caution", "dangerous", "blocked"];

export interface TierTotal {
  tier: RiskTier;
  bytes: number;
  count: number;
}

export interface Insights {
  /** Only tiers that have at least one artifact. */
  tiers: TierTotal[];
  totalBytes: number;
  stale: { bytes: number; count: number };
  /** False when no candidate carries an mtime, so "stale" would be a guess. */
  ageKnown: boolean;
}

/**
 * Aggregate what the scan found by risk tier, plus how much of it has sat
 * untouched for `STALE_AFTER_DAYS`. Blocked artifacts never count toward
 * stale: they cannot be deleted, so they are not reclaimable.
 */
export function buildInsights(candidates: readonly ScanCandidate[], now: number): Insights {
  const byTier = new Map<RiskTier, TierTotal>();
  const stale = { bytes: 0, count: 0 };
  let totalBytes = 0;
  let ageKnown = false;

  for (const candidate of candidates) {
    const entry = byTier.get(candidate.riskTier) ?? {
      tier: candidate.riskTier,
      bytes: 0,
      count: 0,
    };
    entry.bytes += candidate.estimatedBytes;
    entry.count += 1;
    byTier.set(candidate.riskTier, entry);
    totalBytes += candidate.estimatedBytes;

    if (candidate.modifiedMs === undefined) continue;
    ageKnown = true;
    if (
      candidate.riskTier !== "blocked" &&
      now - candidate.modifiedMs >= STALE_AFTER_DAYS * DAY_MS
    ) {
      stale.bytes += candidate.estimatedBytes;
      stale.count += 1;
    }
  }

  return {
    tiers: RISK_ORDER.flatMap((tier) => byTier.get(tier) ?? []),
    totalBytes,
    stale,
    ageKnown,
  };
}

/**
 * Split `width` cells across the tiers in proportion to bytes. Every tier that
 * has any bytes gets at least one cell so a small dangerous slice stays
 * visible, and the cells always add up to exactly `width`.
 */
export function allocateBarCells(tiers: readonly TierTotal[], width: number): number[] {
  const weighted = tiers.filter((entry) => entry.bytes > 0);
  const total = weighted.reduce((sum, entry) => sum + entry.bytes, 0);
  if (width <= 0 || total <= 0) return tiers.map(() => 0);

  const cells: number[] = tiers.map((entry) => (entry.bytes > 0 ? 1 : 0));
  let remaining = width - cells.reduce((sum, value) => sum + value, 0);
  if (remaining < 0) {
    // Fewer cells than tiers: the biggest tiers win the cells.
    const order = tiers
      .map((entry, index) => ({ index, bytes: entry.bytes }))
      .sort((a, b) => b.bytes - a.bytes);
    const out = tiers.map(() => 0);
    for (const { index } of order.slice(0, width)) out[index] = 1;
    return out;
  }

  const shares = tiers.map((entry) => (entry.bytes / total) * remaining);
  const extra = shares.map((share) => Math.floor(share));
  remaining -= extra.reduce((sum, value) => sum + value, 0);
  const byRemainder = shares
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((a, b) => b.remainder - a.remainder);
  for (const { index } of byRemainder) {
    if (remaining <= 0) break;
    if ((tiers[index]?.bytes ?? 0) > 0) {
      extra[index] = (extra[index] ?? 0) + 1;
      remaining -= 1;
    }
  }
  return cells.map((base, index) => base + (extra[index] ?? 0));
}
