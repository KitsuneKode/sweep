import { afterEach, describe, expect, test } from "bun:test";
import { darkTheme, lightTheme, resolveTheme } from "./theme.js";

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
