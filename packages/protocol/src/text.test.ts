import { describe, expect, test } from "bun:test";
import { sanitizeTerminalText } from "./text.js";

describe("sanitizeTerminalText", () => {
  test("leaves ordinary paths untouched", () => {
    expect(sanitizeTerminalText("/repo/apps/cli/node_modules")).toBe("/repo/apps/cli/node_modules");
    expect(sanitizeTerminalText("déjà vu")).toBe("déjà vu");
  });

  test("escapes the ANSI introducer and other C0 controls", () => {
    expect(sanitizeTerminalText("evil\x1b.tsbuildinfo")).toBe("evil\\x1b.tsbuildinfo");
    expect(sanitizeTerminalText("a\nb\tc")).toBe("a\\x0ab\\x09c");
    expect(sanitizeTerminalText("bell\x07")).toBe("bell\\x07");
  });

  test("escapes DEL and C1 controls", () => {
    expect(sanitizeTerminalText("a\x7fb")).toBe("a\\x7fb");
    expect(sanitizeTerminalText("x\x85y")).toBe("x\\x85y");
  });

  test("escapes bidi override and zero-width spoofers", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE can visually reorder displayed text.
    expect(sanitizeTerminalText("a\u202eb")).toBe("a\\u202eb");
    expect(sanitizeTerminalText("a\u200bb")).toBe("a\\u200bb");
    expect(sanitizeTerminalText("a\u2067b")).toBe("a\\u2067b");
    expect(sanitizeTerminalText("a\ufeffb")).toBe("a\\ufeffb");
  });

  test("leaves astral-plane characters alone", () => {
    expect(sanitizeTerminalText("🦊")).toBe("🦊");
  });
  test("escapes line separators and invisible tag characters in consent text", () => {
    expect(sanitizeTerminalText("a\u2028b\u2029c\u{e0061}")).toBe("a\\u2028b\\u2029c\\u{e0061}");
  });
});
