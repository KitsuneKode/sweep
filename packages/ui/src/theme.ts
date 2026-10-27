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
  /** Resting fill of a pressable control, one step above its surface. */
  controlBg: string;
}

/**
 * The sweep brand, shared with the website: olive-black surfaces with a
 * chartreuse signal for focus and the mode chip, and separate
 * warning/danger roles. Text tokens cover the canvas, dialog, hover and
 * soft-selection surfaces. Focused rows use selectionText; risk shapes remain
 * visible without color.
 */
export const darkTheme: ThemeTokens = {
  bg: "#0b0d08",
  surface: "#12150f",
  surfaceInset: "#0e110b",
  border: "#2c3324",
  borderSoft: "#c8d0b026",
  borderFocus: "#cdf450",
  text: "#f2f1e9",
  textSecondary: "#bcbdb0",
  textMuted: "#9b9d8f",
  textDim: "#868979",
  accent: "#cdf450",
  accentContrast: "#1a2108",
  positive: "#bfe35a",
  warning: "#e2b552",
  danger: "#f47f69",
  blocked: "#9ea6b0",
  info: "#a2b4ca",
  selectionBg: "#2c3a18",
  selectionText: "#f5f5ee",
  selectionSoftBg: "#1b2113",
  hoverBg: "#171b12",
  headerText: "#dcdcd2",
  statusBg: "#0e110b",
  overlayBackdrop: "#0b0d08cc",
  meterTrack: "#1d2216",
  controlBg: "#1f2518",
};

/** Paper surfaces; the signal deepens to olive so it keeps contrast on light. */
export const lightTheme: ThemeTokens = {
  bg: "#f7f6f0",
  surface: "#fdfdf9",
  surfaceInset: "#f1f0e8",
  border: "#e3e2d6",
  borderSoft: "#0000000f",
  borderFocus: "#4a6a12",
  text: "#171a10",
  textSecondary: "#3b4130",
  textMuted: "#565c49",
  textDim: "#666b59",
  accent: "#4a6a12",
  accentContrast: "#ffffff",
  positive: "#3f6212",
  warning: "#7a5806",
  danger: "#b0372c",
  blocked: "#58606d",
  info: "#46617c",
  selectionBg: "#d6e4ad",
  selectionText: "#1b1f14",
  selectionSoftBg: "#e9efd7",
  hoverBg: "#ecede2",
  headerText: "#262b1c",
  statusBg: "#fafaf4",
  overlayBackdrop: "#1b1f1455",
  meterTrack: "#e3e2d6",
  controlBg: "#e9e9dd",
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

function rgb(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** `amount` of `over` laid on `base`, both #rrggbb. */
export function mixHex(base: string, over: string, amount: number): string {
  const a = rgb(base);
  const b = rgb(over);
  if (!a || !b) return base;
  const channel = (i: number) =>
    Math.round(a[i]! + (b[i]! - a[i]!) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/** Whether a #rrggbb background reads as dark (relative luminance below the midpoint). */
export function isDarkBackground(hex: string): boolean | null {
  const c = rgb(hex);
  if (!c) return null;
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]) < 0.18;
}

/**
 * Sit on the terminal instead of covering it: the canvas stays the terminal's
 * own background (its colour, its opacity, its blur) and every tint is mixed
 * from that background, so a selection band or a meter track is one quiet
 * step off whatever the user chose. Dialogs keep a solid surface.
 */
function onTerminal(theme: ThemeTokens, background: string): ThemeTokens {
  return {
    ...theme,
    bg: "transparent",
    statusBg: "transparent",
    surface: mixHex(background, theme.text, 0.045),
    surfaceInset: mixHex(background, theme.text, 0.025),
    border: mixHex(background, theme.text, 0.16),
    // Solid: an alpha colour over a transparent canvas would vanish.
    borderSoft: mixHex(background, theme.text, 0.13),
    controlBg: mixHex(background, theme.text, 0.09),
    hoverBg: mixHex(background, theme.text, 0.05),
    meterTrack: mixHex(background, theme.text, 0.1),
    selectionSoftBg: mixHex(background, theme.accent, 0.13),
    selectionBg: mixHex(background, theme.accent, 0.26),
    overlayBackdrop: `${background}cc`,
  };
}

/**
 * NO_COLOR removes hue; contrast, focus, queue shapes and risk labels remain.
 * `terminalBackground` is the terminal's reported default background: in
 * auto mode it decides dark or light, and when the theme matches it the
 * canvas becomes the terminal's own.
 */
export function resolveTheme(mode: ThemeMode, terminalBackground?: string | null): ThemeTokens {
  const terminalDark = terminalBackground ? isDarkBackground(terminalBackground) : null;
  const theme =
    mode === "dark"
      ? darkTheme
      : mode === "light"
        ? lightTheme
        : (terminalDark ?? terminalPrefersDark())
          ? darkTheme
          : lightTheme;
  if (!process.env.NO_COLOR) {
    // Only auto sits on the terminal's own canvas. Dark and light are the
    // look someone chose on purpose: sweep's own solid canvas, the same in
    // every terminal, whatever its background or transparency.
    return mode === "auto" && terminalBackground && terminalDark === (theme === darkTheme)
      ? onTerminal(theme, terminalBackground)
      : theme;
  }
  const dark = theme === darkTheme;
  const text = dark ? "#f5f5f5" : "#1f1f1f";
  const secondary = dark ? "#c9c9c9" : "#474747";
  const muted = dark ? "#a0a0a0" : "#5b5b5b";
  return {
    ...theme,
    bg: dark ? "#0a0a0a" : "#f7f7f7",
    surface: dark ? "#121212" : "#ffffff",
    surfaceInset: dark ? "#0f0f0f" : "#f3f3f3",
    borderSoft: dark ? "#a0a0a026" : "#0000000f",
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
    controlBg: dark ? "#222222" : "#e8e8e8",
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

/** How a one-line notice reads: amber is reserved for things worth a second look. */
export type NoticeTone = "neutral" | "success" | "warning";

export function noticeColor(tone: NoticeTone, theme: ThemeTokens): string {
  if (tone === "success") return theme.positive;
  if (tone === "neutral") return theme.textSecondary;
  return theme.warning;
}
