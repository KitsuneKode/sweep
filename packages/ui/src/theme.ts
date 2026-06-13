import type { RiskTier } from "@kitsunekode/sweep-protocol";

/** Industrial terminal palette — warm amber accent on cool charcoal. */
export const theme = {
  bg: "#0a0d14",
  surface: "#121824",
  surfaceInset: "#0e1219",
  border: "#2d3a52",
  borderMuted: "#1f2937",
  borderFocus: "#f59e0b",
  text: "#e8edf5",
  textMuted: "#8b9bb8",
  textDim: "#5c6b85",
  accent: "#f59e0b",
  accentBright: "#fbbf24",
  info: "#38bdf8",
  positive: "#4ade80",
  warning: "#fbbf24",
  danger: "#f87171",
  blocked: "#c084fc",
  selectionBg: "#1a2f4a",
  selectionText: "#f0f9ff",
  checkboxOn: "#4ade80",
  checkboxOff: "#5c6b85",
} as const;

export const riskColor: Record<RiskTier, string> = {
  safe: theme.positive,
  caution: theme.warning,
  dangerous: theme.danger,
  blocked: theme.blocked,
};

export const riskGlyph: Record<RiskTier, string> = {
  safe: "●",
  caution: "◆",
  dangerous: "▲",
  blocked: "⊘",
};

export const riskTag: Record<RiskTier, string> = {
  safe: "SAFE",
  caution: "CAUTION",
  dangerous: "DANGER",
  blocked: "BLOCKED",
};
