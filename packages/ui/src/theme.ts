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
  positive: string;
  warning: string;
  danger: string;
  blocked: string;
  info: string;
  selectionBg: string;
  selectionText: string;
  headerText: string;
}

export const darkTheme: ThemeTokens = {
  bg: "#090b10",
  surface: "#10141c",
  surfaceInset: "#0c1018",
  border: "#243044",
  borderSoft: "#94a3b824",
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
};

export const lightTheme: ThemeTokens = {
  bg: "#f7f6f3",
  surface: "#ffffff",
  surfaceInset: "#f9f9f8",
  border: "#eaeaea",
  borderSoft: "#0000000f",
  borderFocus: "#956400",
  text: "#111111",
  textSecondary: "#787774",
  textMuted: "#9b9a97",
  textDim: "#b5b3ad",
  accent: "#956400",
  positive: "#346538",
  warning: "#956400",
  danger: "#9f2f2d",
  blocked: "#6b4f9a",
  info: "#1f6c9f",
  selectionBg: "#edf3ec",
  selectionText: "#111111",
  headerText: "#2f3437",
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
