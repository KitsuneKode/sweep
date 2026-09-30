import { describe, expect, test } from "bun:test";
import { describeAge, formatAge, isRecent, sizeBar } from "./age.js";

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const ago = (ms: number) => NOW - ms;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatAge", () => {
  test("unknown time leaves the cell blank", () => {
    expect(formatAge(undefined, NOW)).toBe("");
  });

  test.each([
    [10_000, "now"],
    [5 * MIN, "5m"],
    [3 * HOUR, "3h"],
    [12 * DAY, "12d"],
    [59 * DAY, "59d"],
    [60 * DAY, "2mo"],
    [240 * DAY, "8mo"],
    [729 * DAY, "24mo"],
    [730 * DAY, "2y"],
  ])("%d ms ago reads %s", (elapsed, label) => {
    expect(formatAge(ago(elapsed), NOW)).toBe(label);
  });

  test("a future mtime (clock skew) reads as now", () => {
    expect(formatAge(NOW + 5 * DAY, NOW)).toBe("now");
  });
});

describe("describeAge", () => {
  test("pluralizes and reads as a sentence", () => {
    expect(describeAge(ago(DAY), NOW)).toBe("1 day ago");
    expect(describeAge(ago(3 * DAY), NOW)).toBe("3 days ago");
    expect(describeAge(ago(240 * DAY), NOW)).toBe("8 months ago");
    expect(describeAge(ago(30 * MIN), NOW)).toBe("30 minutes ago");
    expect(describeAge(undefined, NOW)).toBe("");
  });
});

describe("isRecent", () => {
  test("flags the last seven days only", () => {
    expect(isRecent(ago(6 * DAY), NOW)).toBe(true);
    expect(isRecent(ago(8 * DAY), NOW)).toBe(false);
    expect(isRecent(undefined, NOW)).toBe(false);
  });
});

describe("sizeBar", () => {
  test("is always padded to the requested width", () => {
    for (const bytes of [0, 1, 50, 100]) {
      expect(sizeBar(bytes, 100, 4)).toHaveLength(4);
    }
  });

  test("fills proportionally in eighth blocks", () => {
    expect(sizeBar(100, 100, 4)).toBe("████");
    expect(sizeBar(50, 100, 4)).toBe("██  ");
    expect(sizeBar(12.5, 100, 4)).toBe("▌   ");
  });

  test("tiny artifacts stay empty instead of inflating", () => {
    expect(sizeBar(1, 1_000_000, 4)).toBe("    ");
    expect(sizeBar(0, 0, 4)).toBe("    ");
  });
});
