import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { darkTheme, lightTheme, noticeColor, resolveTheme, type ThemeTokens } from "./theme.js";

describe("resolveTheme", () => {
  const original = process.env.COLORFGBG;
  const originalNoColor = process.env.NO_COLOR;
  beforeEach(() => {
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    if (original === undefined) {
      delete process.env.COLORFGBG;
    } else {
      process.env.COLORFGBG = original;
    }
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
      expect(contrast(theme.textDim, theme.selectionSoftBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.selectionText, theme.selectionBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.borderFocus, theme.selectionBg)).toBeGreaterThanOrEqual(3);
      expect(contrast(theme.accentContrast, theme.accent)).toBeGreaterThanOrEqual(4.5);
    }
    process.env.NO_COLOR = "";
    expect(resolveTheme("dark")).toBe(darkTheme);
  });
});

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

function contrast(foreground: string, background: string): number {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

describe.each([
  ["dark", darkTheme],
  ["light", lightTheme],
] as [string, ThemeTokens][])("%s theme contrast", (_name, theme) => {
  test("informational text stays at WCAG AA on every surface", () => {
    const surfaces = [
      theme.bg,
      theme.surface,
      theme.surfaceInset,
      theme.hoverBg,
      theme.selectionSoftBg,
    ];
    const informational = [
      theme.text,
      theme.textSecondary,
      theme.textMuted,
      theme.textDim,
      theme.positive,
      theme.warning,
      theme.danger,
      theme.info,
      theme.accent,
      theme.blocked,
    ];
    for (const surface of surfaces) {
      for (const color of informational) {
        expect(contrast(color, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("mode chip label is readable on the accent block", () => {
    expect(contrast(theme.accentContrast, theme.accent)).toBeGreaterThanOrEqual(4.5);
  });

  test("selected text and the focus rail remain readable", () => {
    expect(contrast(theme.selectionText, theme.selectionBg)).toBeGreaterThanOrEqual(4.5);
    for (const surface of [theme.bg, theme.surface, theme.hoverBg, theme.selectionBg]) {
      expect(contrast(theme.borderFocus, surface)).toBeGreaterThanOrEqual(3);
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
