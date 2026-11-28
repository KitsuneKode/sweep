export type ColorDepth = "none" | "16" | "256" | "truecolor";
export type CostCategory = "cache" | "install" | "build" | "custom";

export interface PaletteOptions {
  depth?: ColorDepth;
  stream?: { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
  theme?: "dark" | "light";
}

export interface Palette {
  readonly depth: ColorDepth;
  readonly isColor: boolean;
  bold: (text: string) => string;
  dim: (text: string) => string;
  accent: (text: string) => string;
  positive: (text: string) => string;
  warning: (text: string) => string;
  danger: (text: string) => string;
  info: (text: string) => string;
  cost: Record<CostCategory, (text: string) => string>;
}

interface ColorSpec {
  rgb: readonly [number, number, number];
  ansi256: number;
  ansi16: number;
}

interface ThemeSpecs {
  accent: ColorSpec;
  positive: ColorSpec;
  warning: ColorSpec;
  danger: ColorSpec;
  info: ColorSpec;
  costCache: ColorSpec;
  costInstall: ColorSpec;
  costBuild: ColorSpec;
  costCustom: ColorSpec;
}

const DARK_SPECS: ThemeSpecs = {
  accent: { rgb: [96, 165, 250], ansi256: 75, ansi16: 94 },
  positive: { rgb: [106, 213, 139], ansi256: 78, ansi16: 32 },
  warning: { rgb: [238, 193, 84], ansi256: 221, ansi16: 33 },
  danger: { rgb: [252, 110, 106], ansi256: 203, ansi16: 31 },
  info: { rgb: [78, 206, 229], ansi256: 80, ansi16: 36 },
  costCache: { rgb: [85, 215, 190], ansi256: 80, ansi16: 36 },
  costInstall: { rgb: [173, 158, 253], ansi256: 141, ansi16: 35 },
  costBuild: { rgb: [251, 152, 74], ansi256: 209, ansi16: 33 },
  costCustom: { rgb: [234, 133, 211], ansi256: 176, ansi16: 95 },
};

const LIGHT_SPECS: ThemeSpecs = {
  accent: { rgb: [29, 78, 216], ansi256: 26, ansi16: 34 },
  positive: { rgb: [3, 106, 52], ansi256: 28, ansi16: 32 },
  warning: { rgb: [119, 88, 1], ansi256: 136, ansi16: 33 },
  danger: { rgb: [169, 34, 41], ansi256: 124, ansi16: 31 },
  info: { rgb: [4, 99, 114], ansi256: 23, ansi16: 36 },
  costCache: { rgb: [2, 103, 88], ansi256: 23, ansi16: 36 },
  costInstall: { rgb: [90, 67, 164], ansi256: 61, ansi16: 35 },
  costBuild: { rgb: [144, 71, 1], ansi256: 130, ansi16: 33 },
  costCustom: { rgb: [138, 51, 121], ansi256: 90, ansi16: 35 },
};

const TRUECOLOR_PROGRAMS = new Set([
  "iTerm.app",
  "WezTerm",
  "vscode",
  "ghostty",
  "Alacritty",
  "Hyper",
  "WarpTerminal",
]);

function detectTerminalDepth(env: NodeJS.ProcessEnv): Exclude<ColorDepth, "none"> {
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return "truecolor";

  const term = (env.TERM ?? "").toLowerCase();
  if (term.includes("truecolor") || term.includes("direct")) return "truecolor";
  if (term.includes("256color")) return "256";
  if (
    term.includes("16color") ||
    term.includes("8color") ||
    term === "linux" ||
    term === "vt100" ||
    term === "vt220" ||
    term === "ansi"
  ) {
    return "16";
  }

  if (env.WT_SESSION || env.KITTY_WINDOW_ID || TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM ?? "")) {
    return "truecolor";
  }
  return "16";
}

/**
 * Resolve ANSI color capability for a target stream dynamically.
 * Respects `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, non-TTY streams, and
 * 16-color / 256-color / truecolor terminals.
 */
export function resolveColorDepth(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if ((env.TERM ?? "").toLowerCase() === "dumb") return "none";

  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "") {
    const normalized = force.trim().toLowerCase();
    if (normalized === "0" || normalized === "false") return "none";
    if (normalized === "3") return "truecolor";
    if (normalized === "2") return "256";
    if (normalized === "1" || normalized === "true") {
      const detected = detectTerminalDepth(env);
      return detected;
    }
    return detectTerminalDepth(env);
  }

  if (stream.isTTY !== true) return "none";
  return detectTerminalDepth(env);
}

function wrapSgr(open: string, close: string): (text: string) => string {
  return (text: string) => {
    if (text.length === 0) return text;
    return `\x1b[${open}m${text}\x1b[${close}m`;
  };
}

function colorFn(spec: ColorSpec, depth: ColorDepth): (text: string) => string {
  if (depth === "none") return (text) => text;
  if (depth === "truecolor") {
    const [r, g, b] = spec.rgb;
    return wrapSgr(`38;2;${r};${g};${b}`, "39");
  }
  if (depth === "256") {
    return wrapSgr(`38;5;${spec.ansi256}`, "39");
  }
  return wrapSgr(String(spec.ansi16), "39");
}

function resolveTheme(options: PaletteOptions): "dark" | "light" {
  if (options.theme) return options.theme;
  const envTheme = (options.env ?? process.env).SWEEP_THEME?.toLowerCase();
  return envTheme === "light" ? "light" : "dark";
}

export function createPalette(options: PaletteOptions = {}): Palette {
  const depth = options.depth ?? resolveColorDepth(options.stream ?? process.stdout, options.env);
  const isColor = depth !== "none";
  const identity = (text: string) => text;
  const specs = resolveTheme(options) === "light" ? LIGHT_SPECS : DARK_SPECS;

  return {
    depth,
    isColor,
    bold: isColor ? wrapSgr("1", "22") : identity,
    dim: isColor ? wrapSgr("2", "22") : identity,
    accent: colorFn(specs.accent, depth),
    positive: colorFn(specs.positive, depth),
    warning: colorFn(specs.warning, depth),
    danger: colorFn(specs.danger, depth),
    info: colorFn(specs.info, depth),
    cost: {
      cache: colorFn(specs.costCache, depth),
      install: colorFn(specs.costInstall, depth),
      build: colorFn(specs.costBuild, depth),
      custom: colorFn(specs.costCustom, depth),
    },
  };
}

/** Map an artifact kind/label to its Direction C+ rebuild-cost category. */
export function costCategoryForKind(kind: string): CostCategory {
  switch (kind) {
    case "node_modules":
    case ".venv":
    case "venv":
    case "vendor":
      return "install";
    case "target":
    case ".next":
    case ".nuxt":
    case ".svelte-kit":
    case "dist":
    case "build":
    case "out":
      return "build";
    case ".turbo":
    case ".vite":
    case ".parcel-cache":
    case "tsbuildinfo":
    case "coverage":
    case ".nyc_output":
    case "__pycache__":
    case ".pytest_cache":
    case ".mypy_cache":
    case ".ruff_cache":
      return "cache";
    default:
      return "custom";
  }
}

/** 1-cell colored rebuild-cost indicator matching Projects View. */
export function costDot(kind: string, palette: Palette): string {
  const cat = costCategoryForKind(kind);
  return palette.cost[cat]("●");
}

/** Proper singular/plural count string: `plural(1, "item")` -> `"1 item"`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Relative time label for ISO timestamps or epoch milliseconds. */
export function formatRelativeTime(timestamp: string | number, now = Date.now()): string {
  const ms = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(ms)) return "";
  const elapsed = Math.max(0, now - ms);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) {
    return `${plural(Math.floor(elapsed / 60_000), "minute")} ago`;
  }
  if (elapsed < 86_400_000) {
    return `${plural(Math.floor(elapsed / 3_600_000), "hour")} ago`;
  }
  const days = Math.floor(elapsed / 86_400_000);
  if (days < 60) return `${plural(days, "day")} ago`;
  if (days < 730) return `${plural(Math.floor(days / 30), "month")} ago`;
  return `${plural(Math.floor(days / 365), "year")} ago`;
}
