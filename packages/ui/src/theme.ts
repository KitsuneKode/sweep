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
 * Charcoal surfaces with sage focus and separate warning/danger roles.
 * Text tokens cover the canvas, dialog, hover and soft-selection surfaces.
 * Focused rows use selectionText; risk shapes remain visible without color.
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
  textDim: "#919191",
  accent: "#829788",
  accentContrast: "#0a0a0a",
  positive: "#8b9d83",
  warning: "#d9a94f",
  danger: "#f26363",
  blocked: "#9198a3",
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
  borderFocus: "#506658",
  text: "#1a1f2e",
  textSecondary: "#474f60",
  textMuted: "#5b6372",
  textDim: "#616875",
  accent: "#506658",
  accentContrast: "#ffffff",
  positive: "#4f6959",
  warning: "#835b0b",
  danger: "#b63532",
  blocked: "#5b6472",
  info: "#4e6680",
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

/** NO_COLOR removes hue; contrast, focus, queue shapes and risk labels remain. */
export function resolveTheme(mode: ThemeMode): ThemeTokens {
  const theme =
    mode === "dark"
      ? darkTheme
      : mode === "light"
        ? lightTheme
        : terminalPrefersDark()
          ? darkTheme
          : lightTheme;
  if (!process.env.NO_COLOR) return theme;
  const dark = theme === darkTheme;
  const text = dark ? "#f5f5f5" : "#1f1f1f";
  const secondary = dark ? "#c9c9c9" : "#474747";
  const muted = dark ? "#a0a0a0" : "#5b5b5b";
  return {
    ...theme,
    bg: dark ? "#0a0a0a" : "#f7f7f7",
    surfaceInset: dark ? "#0f0f0f" : "#f3f3f3",
    border: dark ? "#2a2a2a" : "#e6e6e6",
    accent: dark ? "#c9c9c9" : "#474747",
    accentContrast: dark ? "#0a0a0a" : "#ffffff",
    borderFocus: dark ? "#c9c9c9" : "#474747",
    positive: text,
    warning: text,
    danger: text,
    blocked: muted,
    info: secondary,
    text,
    textSecondary: secondary,
    textMuted: muted,
    textDim: dark ? "#919191" : "#616161",
    selectionBg: dark ? "#3a3a3a" : "#c5c5c5",
    selectionText: dark ? "#f5f5f5" : "#1f1f1f",
    selectionSoftBg: dark ? "#252525" : "#e5e5e5",
    hoverBg: dark ? "#1a1a1a" : "#ededed",
    headerText: dark ? "#d4d4d4" : "#303030",
    overlayBackdrop: dark ? "#0a0a0acc" : "#1f1f1f55",
    statusBg: dark ? "#0f0f0f" : "#fafafa",
    meterTrack: dark ? "#1a1a1a" : "#e6e6e6",
  };
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
