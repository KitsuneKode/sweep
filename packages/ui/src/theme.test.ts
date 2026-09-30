import { afterEach, describe, expect, test } from "bun:test";
import { darkTheme, lightTheme, resolveTheme, type ThemeTokens } from "./theme.js";

describe("resolveTheme", () => {
  const original = process.env.COLORFGBG;

  afterEach(() => {
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
    const surfaces = [theme.bg, theme.surface, theme.surfaceInset];
    const informational = [
      theme.text,
      theme.textSecondary,
      theme.textMuted,
      theme.textDim,
      theme.positive,
      theme.warning,
      theme.danger,
      theme.info,
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
});
