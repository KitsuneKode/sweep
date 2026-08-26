import type { RiskTier } from "@kitsunekode/sweep-protocol";

export interface ThemeTokens {
  bg: string;
  surface: string;
  surfaceInset: string;
  border: string;
  borderSoft: string;
  borderFocus: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  textDim: string;
  accent: string;
  accentContrast: string;
  positive: string;
  warning: string;
  danger: string;
  blocked: string;
  info: string;
  selectionBg: string;
  selectionText: string;
  hoverBg: string;
  headerText: string;
  /** Statusline strip background. */
  statusBg: string;
  /** Translucent scrim behind modal overlays (#rrggbbaa). */
  overlayBackdrop: string;
  /** Unfilled portion of progress meters. */
  meterTrack: string;
}

/**
 * Reclaim / dust-and-ember palette.
 * Structure in charcoal gray; meaning in restrained semantic color;
 * identity in ember amber (the broom, the heat of reclaim).
 */
export const darkTheme: ThemeTokens = {
  bg: "#090b10",
  surface: "#10141c",
  surfaceInset: "#0c1018",
  border: "#1c2430",
  borderSoft: "#94a3b824",
  borderFocus: "#d97706",
  text: "#e2e8f0",
  textSecondary: "#94a3b8",
  textMuted: "#64748b",
  textDim: "#3f4b5a",
  accent: "#f59e0b",
  accentContrast: "#1a1206",
  positive: "#34d399",
  warning: "#fbbf24",
  danger: "#f87171",
  blocked: "#a78bfa",
  info: "#7dd3fc",
  selectionBg: "#162033",
  selectionText: "#f1f5f9",
  hoverBg: "#131a24",
  headerText: "#cbd5e1",
  statusBg: "#10141c",
  overlayBackdrop: "#090b10cc",
  meterTrack: "#1c2430",
};

export const lightTheme: ThemeTokens = {
  bg: "#f7f6f3",
  surface: "#ffffff",
  surfaceInset: "#f9f9f8",
  border: "#e8e6e1",
  borderSoft: "#0000000f",
  borderFocus: "#956400",
  text: "#111111",
  textSecondary: "#5c5a56",
  textMuted: "#787774",
  textDim: "#a8a49c",
  accent: "#956400",
  accentContrast: "#fffaf0",
  positive: "#1d7a4d",
  warning: "#9a6700",
  danger: "#c0392b",
  blocked: "#6b4f9a",
  info: "#1f6c9f",
  selectionBg: "#f5ead4",
  selectionText: "#3b2a0a",
  hoverBg: "#f0eeea",
  headerText: "#2f3437",
  statusBg: "#efede8",
  overlayBackdrop: "#2f343755",
  meterTrack: "#e8e6e1",
};

export type ThemeMode = "dark" | "light" | "auto";

function terminalPrefersDark(): boolean {
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    const background = parts[1];
    if (background === "7" || background === "15") {
      return false;
    }
  }
  return true;
}

export function resolveTheme(mode: ThemeMode): ThemeTokens {
  if (mode === "dark") return darkTheme;
  if (mode === "light") return lightTheme;
  return terminalPrefersDark() ? darkTheme : lightTheme;
}

export function cycleThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === "dark") return "light";
  if (mode === "light") return "auto";
  return "dark";
}

export function riskColor(theme: ThemeTokens): Record<RiskTier, string> {
  return {
    safe: theme.positive,
    caution: theme.warning,
    dangerous: theme.danger,
    blocked: theme.blocked,
  };
}

/** One-character risk markers for dense rows. */
export const riskMark: Record<RiskTier, string> = {
  safe: "·",
  caution: "?",
  dangerous: "!",
  blocked: "×",
};

/** @deprecated Use resolveTheme() — kept for gradual migration */
export const theme = darkTheme;
