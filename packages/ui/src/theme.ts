import type { RiskTier } from "@kitsunekode/sweep-protocol";

/** Quiet terminal palette — structure in gray, meaning in restrained color. */
export const theme = {
  bg: "#090b10",
  surface: "#10141c",
  surfaceInset: "#0c1018",
  border: "#243044",
  borderSoft: "rgba(148, 163, 184, 0.14)",
  borderFocus: "#d97706",
  text: "#e2e8f0",
  textSecondary: "#94a3b8",
  textMuted: "#64748b",
  textDim: "#475569",
  accent: "#d97706",
  positive: "#34d399",
  warning: "#fbbf24",
  danger: "#f87171",
  blocked: "#a78bfa",
  info: "#7dd3fc",
  selectionBg: "#172033",
  selectionText: "#f8fafc",
  headerText: "#cbd5e1",
  checkboxOn: "#34d399",
  checkboxOff: "#64748b",
} as const;

export const riskColor: Record<RiskTier, string> = {
  safe: theme.positive,
  caution: theme.warning,
  dangerous: theme.danger,
  blocked: theme.blocked,
};

/** One-character risk markers for dense rows. */
export const riskMark: Record<RiskTier, string> = {
  safe: "·",
  caution: "?",
  dangerous: "!",
  blocked: "×",
};
