import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  contrastRatio,
  costColors,
  darkAnsi16Theme,
  darkTheme,
  detectColorDepth,
  diskColors,
  lightAnsi16Theme,
  lightTheme,
  mixHex,
  noticeColor,
  resolveTheme,
  ROW_BAR_SOFT,
  ROW_BAR_STRONG,
  type ThemeTokens,
} from "./theme.js";

describe("resolveTheme", () => {
  const original = process.env.COLORFGBG;
  const originalNoColor = process.env.NO_COLOR;
  const originalTerm = process.env.TERM;
  const originalColorterm = process.env.COLORTERM;
  const originalForceColor = process.env.FORCE_COLOR;

  beforeEach(() => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    process.env.COLORTERM = "truecolor";
    process.env.TERM = "xterm-256color";
  });

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    if (original === undefined) delete process.env.COLORFGBG;
    else process.env.COLORFGBG = original;
    if (originalTerm === undefined) delete process.env.TERM;
    else process.env.TERM = originalTerm;
    if (originalColorterm === undefined) delete process.env.COLORTERM;
    else process.env.COLORTERM = originalColorterm;
    if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = originalForceColor;
  });

  test("auto mode reads the terminal's own background and sits on it", () => {
    const onKanagawa = resolveTheme("auto", "#1f1f28");
    expect(onKanagawa.text).toBe(darkTheme.text);
    expect(onKanagawa.bg).toBe("transparent");
    expect(onKanagawa.statusBg).toBe("transparent");
    // Tints are mixed from the terminal background, not the brand canvas.
    expect(onKanagawa.selectionSoftBg).not.toBe(darkTheme.selectionSoftBg);
    expect(resolveTheme("auto", "#fafaf5").text).toBe(lightTheme.text);
  });

  test("dark and light are sweep's own solid canvas on any terminal", () => {
    expect(resolveTheme("light", "#1f1f28")).toEqual(lightTheme);
    expect(resolveTheme("light", "#fafaf5")).toEqual(lightTheme);
    expect(resolveTheme("dark", "#1f1f28")).toEqual(darkTheme);
    expect(resolveTheme("dark", "#fafaf5")).toEqual(darkTheme);
  });

  test("dark mode returns dark theme", () => {
    expect(resolveTheme("dark")).toEqual(darkTheme);
  });

  test("light mode returns light theme", () => {
    expect(resolveTheme("light")).toEqual(lightTheme);
  });

  test("auto mode follows terminal background hint", () => {
    process.env.COLORFGBG = "0;15";
    expect(resolveTheme("auto")).toEqual(lightTheme);
    process.env.COLORFGBG = "0;0";
    expect(resolveTheme("auto")).toEqual(darkTheme);
  });

  test("nonempty NO_COLOR removes hue in both themes without erasing focus", () => {
    process.env.NO_COLOR = "1";
    for (const mode of ["dark", "light"] as const) {
      const theme = resolveTheme(mode);
      for (const [key, color] of Object.entries(theme)) {
        const components = color.slice(1, 7).match(/../g)!;
        expect(components[0], key).toBe(components[1]);
        expect(components[1], key).toBe(components[2]);
      }
      expect(contrastRatio(theme.textDim, theme.selectionSoftBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.selectionText, theme.selectionBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.borderFocus, theme.selectionBg)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(theme.accentContrast, theme.accent)).toBeGreaterThanOrEqual(4.5);
    }
    process.env.NO_COLOR = "";
    expect(resolveTheme("dark")).toBe(darkTheme);
  });

  test("NO_COLOR in auto mode preserves transparent terminal background with zero hue", () => {
    process.env.NO_COLOR = "1";
    const autoColoredDark = resolveTheme("auto", "#263d55");
    expect(autoColoredDark.bg).toBe("transparent");
    expect(autoColoredDark.statusBg).toBe("transparent");
    expect(autoColoredDark.accent).toBe("#d4d4d4");
    for (const [key, color] of Object.entries(autoColoredDark)) {
      if (color === "transparent") continue;
      const components = color.slice(1, 7).match(/../g)!;
      expect(components[0], `${key}=${color}`).toBe(components[1]);
      expect(components[1], `${key}=${color}`).toBe(components[2]);
    }

    const autoColoredLight = resolveTheme("auto", "#e8f0ff");
    expect(autoColoredLight.bg).toBe("transparent");
    expect(autoColoredLight.statusBg).toBe("transparent");
    expect(autoColoredLight.accent).toBe("#323232");
    for (const [key, color] of Object.entries(autoColoredLight)) {
      if (color === "transparent") continue;
      const components = color.slice(1, 7).match(/../g)!;
      expect(components[0], `${key}=${color}`).toBe(components[1]);
      expect(components[1], `${key}=${color}`).toBe(components[2]);
    }
  });

  test("color depth detection covers NO_COLOR, FORCE_COLOR, COLORTERM, and TERM", () => {
    expect(detectColorDepth({ TERM: "linux" })).toBe("16");
    expect(detectColorDepth({ TERM: "xterm" })).toBe("16");
    expect(detectColorDepth({ TERM: "xterm-16color" })).toBe("16");
    expect(detectColorDepth({ TERM: "xterm-256color" })).toBe("256");
    expect(detectColorDepth({ TERM: "xterm-256color", COLORTERM: "truecolor" })).toBe("truecolor");
    expect(detectColorDepth({ TERM: "xterm", COLORTERM: "24bit" })).toBe("truecolor");
    expect(detectColorDepth({ TERM: "dumb" })).toBe("none");
    expect(detectColorDepth({ TERM: "xterm-256color", FORCE_COLOR: "0" })).toBe("none");
    expect(detectColorDepth({ TERM: "xterm-256color", FORCE_COLOR: "1" })).toBe("16");
    expect(detectColorDepth({ TERM: "xterm-256color", FORCE_COLOR: "2" })).toBe("256");
    expect(detectColorDepth({ TERM: "linux", FORCE_COLOR: "3" })).toBe("truecolor");
    expect(
      detectColorDepth({ TERM: "xterm-256color", COLORTERM: "truecolor", NO_COLOR: "1" }),
    ).toBe("none");

    delete process.env.COLORTERM;
    process.env.TERM = "xterm-16color";
    expect(resolveTheme("dark")).toEqual(darkAnsi16Theme);
    expect(resolveTheme("light")).toEqual(lightAnsi16Theme);

    expect(resolveTheme("dark", null, { colorDepth: "16" })).toEqual(darkAnsi16Theme);
    expect(resolveTheme("light", null, { colorDepth: "16" })).toEqual(lightAnsi16Theme);
  });
});

describe("category hue separation", () => {
  test.each([
    ["dark", darkTheme],
    ["light", lightTheme],
  ] as [string, ThemeTokens][])(
    "%s C+ palette keeps accent distinct from cost and disk hues",
    (_name, theme) => {
      const costs = Object.values(costColors(theme));
      expect(new Set(costs).size).toBe(4);
      for (const color of costs) {
        expect(color).not.toBe(theme.accent);
        expect(color).not.toBe(theme.danger);
        expect(color).not.toBe(theme.warning);
      }

      const disks = Object.values(diskColors(theme));
      expect(disks).toHaveLength(11);
      expect(new Set(disks).size).toBe(11);
      for (const color of disks) {
        expect(color).not.toBe(theme.accent);
        expect(color).not.toBe(theme.danger);
        expect(color).not.toBe(theme.warning);
      }
    },
  );
});

const CONTRAST_SUITES: [string, ThemeTokens][] = [
  ["dark (C+)", darkTheme],
  ["light (C+)", lightTheme],
  ["dark (ANSI-16)", darkAnsi16Theme],
  ["light (ANSI-16)", lightAnsi16Theme],
  ["dark (NO_COLOR)", resolveTheme("dark", null, { colorDepth: "none" })],
  ["light (NO_COLOR)", resolveTheme("light", null, { colorDepth: "none" })],
];

describe.each(CONTRAST_SUITES)("%s WCAG 2.1 contrast", (_name, theme) => {
  test("every text, semantic, cost, and disk token holds >= 4.5:1 on every surface", () => {
    const surfaces = [
      ["bg", theme.bg],
      ["surface", theme.surface],
      ["surfaceInset", theme.surfaceInset],
      ["hoverBg", theme.hoverBg],
      ["selectionSoftBg", theme.selectionSoftBg],
      ["controlBg", theme.controlBg],
    ] as const;

    const foregrounds = [
      ["text", theme.text],
      ["headerText", theme.headerText],
      ["textSecondary", theme.textSecondary],
      ["textMuted", theme.textMuted],
      ["textDim", theme.textDim],
      ["positive", theme.positive],
      ["warning", theme.warning],
      ["danger", theme.danger],
      ["info", theme.info],
      ["accent", theme.accent],
      ["blocked", theme.blocked],
      ["costCache", theme.costCache],
      ["costInstall", theme.costInstall],
      ["costBuild", theme.costBuild],
      ["costCustom", theme.costCustom],
      ["diskDeveloper", theme.diskDeveloper],
      ["diskApps", theme.diskApps],
      ["diskPhotos", theme.diskPhotos],
      ["diskVideos", theme.diskVideos],
      ["diskMusic", theme.diskMusic],
      ["diskDocs", theme.diskDocs],
      ["diskDownloads", theme.diskDownloads],
      ["diskSystem", theme.diskSystem],
      ["diskCaches", theme.diskCaches],
      ["diskTrash", theme.diskTrash],
      ["diskOther", theme.diskOther],
    ] as const;

    for (const [surfaceName, surface] of surfaces) {
      for (const [fgName, color] of foregrounds) {
        expect(contrastRatio(color, surface), `${fgName} on ${surfaceName}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  test("project size bars hold 3:1 on the page and on the cursor row", () => {
    for (const mix of [ROW_BAR_SOFT, ROW_BAR_STRONG]) {
      const bar = mixHex(theme.meterTrack, theme.textMuted, mix);
      expect(contrastRatio(bar, theme.bg)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(bar, theme.selectionSoftBg)).toBeGreaterThanOrEqual(3);
    }
  });

  test("button labels and their shortcut hints read on the control fill and hover border", () => {
    for (const fill of [theme.controlBg, theme.border]) {
      for (const color of [theme.text, theme.textMuted, theme.danger]) {
        expect(contrastRatio(color, fill)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("mode chip label is readable on the accent block", () => {
    expect(contrastRatio(theme.accentContrast, theme.accent)).toBeGreaterThanOrEqual(4.5);
  });

  test("selected text and the focus rail remain readable", () => {
    expect(contrastRatio(theme.selectionText, theme.selectionBg)).toBeGreaterThanOrEqual(4.5);
    for (const surface of [
      theme.bg,
      theme.surface,
      theme.hoverBg,
      theme.selectionBg,
      theme.selectionSoftBg,
    ]) {
      expect(contrastRatio(theme.borderFocus, surface)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("notice tones", () => {
  test("only warnings use the warning colour", () => {
    for (const theme of [darkTheme, lightTheme]) {
      expect(noticeColor("warning", theme)).toBe(theme.warning);
      expect(noticeColor("success", theme)).toBe(theme.positive);
      expect(noticeColor("neutral", theme)).toBe(theme.textSecondary);
      expect(noticeColor("success", theme)).not.toBe(theme.warning);
    }
  });
});
