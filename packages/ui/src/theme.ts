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
  /** Applied-but-unfocused rows (e.g. the active scope while the list has focus). */
  selectionSoftBg: string;
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
 * Helio palette - ported from helio's shadcn-style tokens (lib/theme.ts).
 * Structure in neutral charcoal; meaning in restrained semantic color;
 * identity in muted sage green (oklch 0.633 0.031 155 ≈ #7c9082).
 * Risk tiers: safe = sage, caution = amber, dangerous = red, blocked = slate.
 * Caution is amber, not olive: an olive sat about 7 ΔE from safe sage and the
 * two tiers read as one color. textDim stays at 4.5:1 or better on surfaces,
 * since it styles real information (column headers, scope sizes).
 */
export const darkTheme: ThemeTokens = {
  bg: "#0a0a0a",
  surface: "#121212",
  surfaceInset: "#0f0f0f",
  border: "#2a2a2a",
  borderSoft: "#a0a0a026",
  borderFocus: "#7c9082",
  text: "#f5f5f5",
  textSecondary: "#c9c9c9",
  textMuted: "#a0a0a0",
  textDim: "#808080",
  accent: "#7c9082",
  accentContrast: "#0a0a0a",
  positive: "#8b9d83",
  warning: "#d9a94f",
  danger: "#ef4444",
  blocked: "#6b7280",
  info: "#93a0b4",
  selectionBg: "#36443a",
  selectionText: "#f5f5f5",
  selectionSoftBg: "#222b26",
  hoverBg: "#1a1a1a",
  headerText: "#d4d4d4",
  statusBg: "#0f0f0f",
  overlayBackdrop: "#0a0a0acc",
  meterTrack: "#1a1a1a",
};

export const lightTheme: ThemeTokens = {
  bg: "#f8f7f4",
  surface: "#ffffff",
  surfaceInset: "#f4f3ef",
  border: "#e8e6e1",
  borderSoft: "#0000000f",
  borderFocus: "#7c9082",
  text: "#1a1f2e",
  textSecondary: "#474f60",
  textMuted: "#5b6372",
  textDim: "#686f7c",
  accent: "#7c9082",
  accentContrast: "#141824",
  positive: "#597564",
  warning: "#8a6212",
  danger: "#c73e3a",
  blocked: "#5b6472",
  info: "#56718b",
  selectionBg: "#bfc9bb",
  selectionText: "#1a1f2e",
  selectionSoftBg: "#e3e8e0",
  hoverBg: "#edeee8",
  headerText: "#2a3040",
  statusBg: "#fafaf8",
  overlayBackdrop: "#1a1f2e55",
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
