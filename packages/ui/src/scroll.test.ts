import { describe, expect, test } from "bun:test";
import { nextScrollTop } from "./scroll.js";

describe("nextScrollTop", () => {
  test("holds still while the cursor is comfortably inside the viewport", () => {
    expect(nextScrollTop(10, 20, 15)).toBe(10);
  });

  test("scrolls up just enough to keep a row of context above the cursor", () => {
    expect(nextScrollTop(10, 20, 10)).toBe(9);
    expect(nextScrollTop(10, 20, 4)).toBe(3);
  });

  test("scrolls down just enough to keep a row of context below the cursor", () => {
    // Viewport covers rows 10..29; cursor at 29 needs 30 visible too.
    expect(nextScrollTop(10, 20, 29)).toBe(11);
  });

  test("never scrolls above the top of the list", () => {
    expect(nextScrollTop(0, 20, 0)).toBe(0);
    expect(nextScrollTop(2, 20, 0)).toBe(0);
  });

  test("drops the margin rather than thrash in a viewport too small to hold it", () => {
    expect(nextScrollTop(0, 1, 0)).toBe(0);
    expect(nextScrollTop(0, 1, 5)).toBe(5);
  });

  test("moves by one row per step instead of recentering", () => {
    // The jitter this replaced came from recentering on every move.
    let top = 0;
    for (let cursor = 0; cursor < 40; cursor++) top = nextScrollTop(top, 20, cursor);
    expect(top).toBe(21);
  });
});
