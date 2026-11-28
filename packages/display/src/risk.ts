import type { RiskTier } from "@kitsunekode/sweep-protocol";
import { createPalette, type Palette } from "./palette.js";

export type RiskBadgeLabel = "safe" | "caution" | "dangerous" | "blocked";

/** Map protocol risk tiers to terminal badge labels. */
export function riskBadgeLabel(tier: RiskTier): RiskBadgeLabel {
  switch (tier) {
    case "caution":
      return "caution";
    case "dangerous":
      return "dangerous";
    case "blocked":
      return "blocked";
    case "safe":
    default:
      return "safe";
  }
}

/** Format a colored risk badge for terminal output. */
export function formatRiskBadge(tier: RiskTier, palette: Palette = createPalette()): string {
  const label = riskBadgeLabel(tier);
  switch (label) {
    case "dangerous":
    case "blocked":
      return palette.danger(`[${label}]`);
    case "caution":
      return palette.warning(`[${label}]`);
    case "safe":
    default:
      return palette.positive(`[${label}]`);
  }
}
