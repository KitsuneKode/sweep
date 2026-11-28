import type { RiskTier } from "@kitsunekode/sweep-protocol";

/** Rebuild-cost bucket keys used by the hero bar, legend, and project details. */
export type CostCategory = "cache" | "install" | "build" | "unknown";

/** Whole-disk report category keys (Direction C+, 11 distinct hues). */
export type DiskCategory =
  | "developer"
  | "apps"
  | "photos"
  | "videos"
  | "music"
  | "documents"
  | "downloads"
  | "system"
  | "caches"
  | "trash"
  | "other";

export type ColorDepth = "truecolor" | "256" | "16" | "none";

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
  /** Rebuild-cost category hues (all separated from Clove blue accent). */
  costCache: string;
  costInstall: string;
  costBuild: string;
  costCustom: string;
  /** Whole-disk category hues (11 distinct hues, all separated from accent/risk). */
  diskDeveloper: string;
  diskApps: string;
  diskPhotos: string;
  diskVideos: string;
  diskMusic: string;
  diskDocs: string;
  diskDownloads: string;
  diskSystem: string;
  diskCaches: string;
  diskTrash: string;
  diskOther: string;
}

/**
 * Direction C+ (Refined Clove) dark palette: crisp charcoal surfaces with a
 * single Clove blue accent reserved exclusively for focus, queued state, and
 * primary actions. Every semantic, rebuild-cost, and whole-disk category hue
 * sits at a distinct OKLCH angle and passes WCAG 2.1 AA contrast across all
 * painted surfaces.
 */
export const darkTheme: ThemeTokens = {
  bg: "#111113",
  surface: "#1b1c1f",
  surfaceInset: "#16171a",
  border: "#2e3036",
  borderSoft: "#ffffff24",
  borderFocus: "#60a5fa",
  text: "#f7f7f8",
  textSecondary: "#d2d3d8",
  textMuted: "#abacb5",
  textDim: "#9496a0",
  accent: "#60a5fa",
  accentContrast: "#0a0b0c",
  positive: "#6ad58b",
  warning: "#eec154",
  danger: "#fc6e6a",
  blocked: "#9aa0ac",
  info: "#4ecee5",
  selectionBg: "#243652",
  selectionText: "#f7f7f8",
  selectionSoftBg: "#21252e",
  hoverBg: "#23252a",
  headerText: "#e4e5e9",
  statusBg: "#16171a",
  overlayBackdrop: "#0a0b0ccc",
  meterTrack: "#2a2c32",
  controlBg: "#26282e",
  costCache: "#55d7be",
  costInstall: "#ad9efd",
  costBuild: "#fb984a",
  costCustom: "#ea85d3",
  diskDeveloper: "#ad9efd",
  diskApps: "#5fc9f4",
  diskPhotos: "#fa7fb3",
  diskVideos: "#cf8bea",
  diskMusic: "#90d378",
  diskDocs: "#56d3da",
  diskDownloads: "#c6d163",
  diskSystem: "#a6a19a",
  diskCaches: "#55d7be",
  diskTrash: "#fe895a",
  diskOther: "#dbae7b",
};

/**
 * Direction C+ (Refined Clove) light palette: clean paper-white surfaces with
 * deep royal-blue focus accent and AA-verified hues across all surfaces.
 */
export const lightTheme: ThemeTokens = {
  bg: "#fafafa",
  surface: "#ffffff",
  surfaceInset: "#f2f3f5",
  border: "#dcdde2",
  borderSoft: "#1112141a",
  borderFocus: "#1d4ed8",
  text: "#111214",
  textSecondary: "#32343a",
  textMuted: "#4b4e57",
  textDim: "#575a65",
  accent: "#1d4ed8",
  accentContrast: "#ffffff",
  positive: "#036a34",
  warning: "#775801",
  danger: "#a92229",
  blocked: "#525763",
  info: "#046372",
  selectionBg: "#d6e4fd",
  selectionText: "#111214",
  selectionSoftBg: "#edf2fc",
  hoverBg: "#f1f2f5",
  headerText: "#1e2024",
  statusBg: "#f2f3f5",
  overlayBackdrop: "#11121455",
  meterTrack: "#e2e4ea",
  controlBg: "#e8eaef",
  costCache: "#026758",
  costInstall: "#5a43a4",
  costBuild: "#904701",
  costCustom: "#8a3379",
  diskDeveloper: "#5a43a4",
  diskApps: "#00617f",
  diskPhotos: "#9c2c62",
  diskVideos: "#7a3992",
  diskMusic: "#346620",
  diskDocs: "#056569",
  diskDownloads: "#5b6100",
  diskSystem: "#5a554e",
  diskCaches: "#026758",
  diskTrash: "#983803",
  diskOther: "#7a5526",
};

/**
 * 16-colour terminal fallback (dark): high-contrast ANSI-16-aligned palette
 * so basic consoles (`linux`, `vt100`, `ansi`, `xterm-16color`) stay legible
 * without subtle truecolor shades collapsing together.
 */
export const darkAnsi16Theme: ThemeTokens = {
  bg: "#000000",
  surface: "#121212",
  surfaceInset: "#0a0a0a",
  border: "#262626",
  borderSoft: "#ffffff24",
  borderFocus: "#5faaff",
  text: "#ffffff",
  textSecondary: "#d0d0d0",
  textMuted: "#b0b0b0",
  textDim: "#999999",
  accent: "#5faaff",
  accentContrast: "#000000",
  positive: "#55e055",
  warning: "#f5d742",
  danger: "#ff6666",
  blocked: "#9e9e9e",
  info: "#55e5e5",
  selectionBg: "#1e3a5f",
  selectionText: "#ffffff",
  selectionSoftBg: "#1a2233",
  hoverBg: "#1c1c1c",
  headerText: "#e5e5e5",
  statusBg: "#0a0a0a",
  overlayBackdrop: "#000000cc",
  meterTrack: "#262626",
  controlBg: "#202020",
  costCache: "#55e5e5",
  costInstall: "#c299ff",
  costBuild: "#ffaa55",
  costCustom: "#ff77dd",
  diskDeveloper: "#c299ff",
  diskApps: "#55ccff",
  diskPhotos: "#ff77aa",
  diskVideos: "#dd88ff",
  diskMusic: "#77ee77",
  diskDocs: "#55e5e5",
  diskDownloads: "#d4e055",
  diskSystem: "#b0a89e",
  diskCaches: "#55e5e5",
  diskTrash: "#ff8855",
  diskOther: "#e0b877",
};

/** 16-colour terminal fallback (light). */
export const lightAnsi16Theme: ThemeTokens = {
  bg: "#ffffff",
  surface: "#ffffff",
  surfaceInset: "#f2f2f2",
  border: "#d8d8d8",
  borderSoft: "#0000001a",
  borderFocus: "#0044cc",
  text: "#000000",
  textSecondary: "#2e2e2e",
  textMuted: "#474747",
  textDim: "#545454",
  accent: "#0044cc",
  accentContrast: "#ffffff",
  positive: "#006600",
  warning: "#7a5200",
  danger: "#aa0000",
  blocked: "#4f4f4f",
  info: "#006060",
  selectionBg: "#cfe0fc",
  selectionText: "#000000",
  selectionSoftBg: "#e8effc",
  hoverBg: "#efefef",
  headerText: "#1a1a1a",
  statusBg: "#f2f2f2",
  overlayBackdrop: "#00000055",
  meterTrack: "#e0e0e0",
  controlBg: "#e6e6e6",
  costCache: "#006060",
  costInstall: "#5522aa",
  costBuild: "#884400",
  costCustom: "#880066",
  diskDeveloper: "#5522aa",
  diskApps: "#005588",
  diskPhotos: "#991155",
  diskVideos: "#772288",
  diskMusic: "#226622",
  diskDocs: "#006060",
  diskDownloads: "#555c00",
  diskSystem: "#55504a",
  diskCaches: "#006060",
  diskTrash: "#993300",
  diskOther: "#774f1e",
};

function noColorPalette(dark: boolean): ThemeTokens {
  const text = dark ? "#f5f5f5" : "#141414";
  const secondary = dark ? "#d0d0d0" : "#383838";
  const muted = dark ? "#aaaaaa" : "#525252";
  const dim = dark ? "#949494" : "#5e5e5e";
  const blocked = dark ? "#a0a0a0" : "#595959";
  return {
    bg: dark ? "#0a0a0a" : "#fafafa",
    surface: dark ? "#121212" : "#ffffff",
    surfaceInset: dark ? "#0f0f0f" : "#f2f2f2",
    borderSoft: dark ? "#ffffff24" : "#0000001a",
    border: dark ? "#343434" : "#dcdcdc",
    accent: dark ? "#d4d4d4" : "#323232",
    accentContrast: dark ? "#0a0a0a" : "#ffffff",
    borderFocus: dark ? "#d4d4d4" : "#323232",
    positive: text,
    warning: text,
    danger: text,
    blocked,
    info: secondary,
    text,
    textSecondary: secondary,
    textMuted: muted,
    textDim: dim,
    selectionBg: dark ? "#3a3a3a" : "#cccccc",
    selectionText: dark ? "#ffffff" : "#141414",
    selectionSoftBg: dark ? "#222222" : "#e6e6e6",
    hoverBg: dark ? "#1c1c1c" : "#ededed",
    headerText: dark ? "#e0e0e0" : "#262626",
    overlayBackdrop: dark ? "#0a0a0acc" : "#14141455",
    statusBg: dark ? "#0f0f0f" : "#f5f5f5",
    meterTrack: dark ? "#262626" : "#e2e2e2",
    controlBg: dark ? "#242424" : "#e6e6e6",
    costCache: secondary,
    costInstall: text,
    costBuild: muted,
    costCustom: blocked,
    diskDeveloper: text,
    diskApps: secondary,
    diskPhotos: muted,
    diskVideos: secondary,
    diskMusic: muted,
    diskDocs: secondary,
    diskDownloads: muted,
    diskSystem: blocked,
    diskCaches: secondary,
    diskTrash: text,
    diskOther: blocked,
  };
}

export type ThemeMode = "dark" | "light" | "auto";

const ANSI16_TERM_PATTERN =
  /^(vt100|vt102|vt220|ansi|linux|cons25|cygwin|xterm|xterm-color|xterm-16color|screen|tmux|rxvt)$/i;

/**
 * Determine terminal colour depth from standard environment variables.
 * - Nonempty `NO_COLOR`, `FORCE_COLOR=0`, or `TERM=dumb` -> `"none"`
 * - `FORCE_COLOR=1` -> `"16"`, `FORCE_COLOR=2` -> `"256"`, `FORCE_COLOR=3` -> `"truecolor"`
 * - `COLORTERM=truecolor|24bit` -> `"truecolor"`
 * - `TERM` containing `256color` -> `"256"`
 * - Basic 16-colour consoles (`linux`, `xterm`, `vt100`, `ansi`, `xterm-16color`, etc.) -> `"16"`
 * - Modern terminals (or unset env in headless tests) -> `"truecolor"`
 */
export function detectColorDepth(env: NodeJS.ProcessEnv = process.env): ColorDepth {
  if (env.NO_COLOR) return "none";
  const forceColor = env.FORCE_COLOR?.trim();
  if (forceColor === "0") return "none";
  if (forceColor === "1") return "16";
  if (forceColor === "2") return "256";
  if (forceColor === "3") return "truecolor";
  const term = env.TERM?.trim() ?? "";
  if (term.toLowerCase() === "dumb") return "none";
  const colorterm = env.COLORTERM?.trim() ?? "";
  if (/truecolor|24bit/i.test(colorterm)) return "truecolor";
  if (/256color/i.test(term)) return "256";
  if (ANSI16_TERM_PATTERN.test(term)) return "16";
  return "truecolor";
}

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

/** WCAG 2.1 relative luminance for a `#rrggbb` colour, in `[0, 1]`. */
export function relativeLuminance(hex: string): number {
  const c = rgb(hex);
  if (!c) return 0;
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG 2.1 contrast ratio between two `#rrggbb` colours (`1` to `21`). */
export function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
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
  if (!rgb(hex)) return null;
  return relativeLuminance(hex) < 0.18;
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
    meterTrack: mixHex(background, theme.text, 0.12),
    selectionSoftBg: mixHex(background, theme.accent, 0.13),
    selectionBg: mixHex(background, theme.accent, 0.25),
    overlayBackdrop: `${background}cc`,
  };
}

export interface ResolveThemeOptions {
  /** Override auto-detected terminal colour depth (useful for testing and explicit overrides). */
  colorDepth?: ColorDepth;
}

/**
 * Resolve the active C+ token set for the requested `--theme` mode (`auto | dark | light`),
 * terminal background, and terminal colour depth (`truecolor | 16 | none`).
 *
 * - `NO_COLOR` (depth `"none"`) removes hue while keeping contrast, focus, queue shapes,
 *   and risk labels intact. In `auto` mode with a matching `terminalBackground`, `bg` and
 *   `statusBg` stay `"transparent"` instead of painting over the user's terminal canvas.
 * - 16-colour consoles (depth `"16"`) fall back to the high-contrast ANSI-16 C+ palette.
 * - Explicit `dark` and `light` always paint sweep's own solid C+ canvas.
 */
export function resolveTheme(
  mode: ThemeMode,
  terminalBackground?: string | null,
  options?: ResolveThemeOptions,
): ThemeTokens {
  const terminalDark = terminalBackground ? isDarkBackground(terminalBackground) : null;
  const dark =
    mode === "dark" ? true : mode === "light" ? false : (terminalDark ?? terminalPrefersDark());
  const depth = options?.colorDepth ?? detectColorDepth();

  const base =
    depth === "none"
      ? noColorPalette(dark)
      : depth === "16"
        ? dark
          ? darkAnsi16Theme
          : lightAnsi16Theme
        : dark
          ? darkTheme
          : lightTheme;

  // Only `auto` sits on the terminal's own canvas (including under NO_COLOR).
  // Explicit dark and light are sweep's own solid canvas on every terminal.
  if (mode === "auto" && terminalBackground && terminalDark === dark) {
    if (depth === "none") {
      // Never mix a colored terminal background into NO_COLOR surfaces: keep
      // the terminal's own canvas transparent and every token strictly neutral.
      return {
        ...base,
        bg: "transparent",
        statusBg: "transparent",
      };
    }
    return onTerminal(base, terminalBackground);
  }
  return base;
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

/** Rebuild-cost category colours, each separated from the Clove blue focus accent. */
export function costColors(theme: ThemeTokens): Record<CostCategory, string> {
  return {
    cache: theme.costCache,
    install: theme.costInstall,
    build: theme.costBuild,
    unknown: theme.costCustom,
  };
}

/** Whole-disk report category colours across all 11 categories. */
export function diskColors(theme: ThemeTokens): Record<DiskCategory, string> {
  return {
    developer: theme.diskDeveloper,
    apps: theme.diskApps,
    photos: theme.diskPhotos,
    videos: theme.diskVideos,
    music: theme.diskMusic,
    documents: theme.diskDocs,
    downloads: theme.diskDownloads,
    system: theme.diskSystem,
    caches: theme.diskCaches,
    trash: theme.diskTrash,
    other: theme.diskOther,
  };
}

/** How a one-line notice reads: amber is reserved for things worth a second look. */
export type NoticeTone = "neutral" | "success" | "warning";

export function noticeColor(tone: NoticeTone, theme: ThemeTokens): string {
  if (tone === "success") return theme.positive;
  if (tone === "neutral") return theme.textSecondary;
  return theme.warning;
}

/**
 * How far the quiet size bars on project rows sit from the track toward the
 * muted text colour. Chosen so a bar holds 3:1 against the page and against
 * the cursor row in both themes (WCAG non-text contrast); the cursor's own
 * bar is the louder step.
 */
export const ROW_BAR_SOFT = 0.7;
export const ROW_BAR_STRONG = 0.9;
