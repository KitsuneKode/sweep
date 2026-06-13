import pc from "picocolors";
import type { RiskTier } from "@kitsunekode/sweep-protocol";

export type RiskBadgeLabel = "safe" | "warning" | "dangerous" | "blocked";

/** Map protocol risk tiers to terminal badge labels. */
export function riskBadgeLabel(tier: RiskTier): RiskBadgeLabel {
  switch (tier) {
    case "caution":
      return "warning";
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
export function formatRiskBadge(tier: RiskTier): string {
  const label = riskBadgeLabel(tier);
  switch (label) {
    case "dangerous":
    case "blocked":
      return pc.red(`[${label}]`);
    case "warning":
      return pc.yellow(`[${label}]`);
    case "safe":
    default:
      return pc.green(`[${label}]`);
  }
}
