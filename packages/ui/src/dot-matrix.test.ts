import { describe, expect, test } from "bun:test";
import {
  DOT_CYCLE,
  DOT_GRID,
  DOT_LEVELS,
  dotFrame,
  dotLevel,
  dotPulse,
  dotRamp,
  dotStrip,
} from "./dot-matrix.js";

describe("dotPulse", () => {
  test("stays within [0, 1] across the whole cycle", () => {
    for (let i = 0; i <= 100; i++) {
      const value = dotPulse(i / 100);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  test("peaks at the dot's own delay and decays after it", () => {
    expect(dotPulse(0.18)).toBeCloseTo(1, 5);
    expect(dotPulse(0.4)).toBeLessThan(1);
    expect(dotPulse(0.8)).toBe(0);
  });

  test("wraps, so a negative phase is the tail of the previous cycle", () => {
    expect(dotPulse(-0.1)).toBe(dotPulse(0.9));
  });
});

describe("dotFrame", () => {
  test("renders a square grid of valid levels", () => {
    const grid = dotFrame("pulseRings", 3);
    expect(grid.length).toBe(DOT_GRID);
    for (const row of grid) {
      expect(row.length).toBe(DOT_GRID);
      for (const level of row) {
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThan(DOT_LEVELS);
      }
    }
  });

  test("actually animates — the grid is not the same on every frame", () => {
    const frames = new Set<string>();
    for (let f = 0; f < DOT_CYCLE; f++) frames.add(JSON.stringify(dotFrame("pulseRings", f)));
    expect(frames.size).toBeGreaterThan(1);
  });

  test("loops cleanly after one cycle", () => {
    expect(dotFrame("wave", 0)).toEqual(dotFrame("wave", DOT_CYCLE));
  });

  test("pulseRings is symmetric about the centre", () => {
    const grid = dotFrame("pulseRings", 5);
    expect(grid[0]?.[0]).toBe(grid[DOT_GRID - 1]?.[DOT_GRID - 1]);
    expect(grid[0]?.[DOT_GRID - 1]).toBe(grid[DOT_GRID - 1]?.[0]);
  });

  test("scan lights a whole column at once", () => {
    for (let f = 0; f < DOT_CYCLE; f++) {
      const column = dotLevel("scan", 2, 0, f);
      for (let y = 1; y < DOT_GRID; y++) expect(dotLevel("scan", 2, y, f)).toBe(column);
    }
  });
});

describe("dotStrip", () => {
  test("returns one level per cell and animates", () => {
    expect(dotStrip("scan", 0, 7).length).toBe(7);
    const frames = new Set<string>();
    for (let f = 0; f < DOT_CYCLE; f++) frames.add(dotStrip("scan", f, 7).join(","));
    expect(frames.size).toBeGreaterThan(1);
  });
});

describe("dotRamp", () => {
  test("interpolates between the endpoints", () => {
    const ramp = dotRamp("#000000", "#ffffff");
    expect(ramp.length).toBe(DOT_LEVELS);
    expect(ramp[0]).toBe("#000000");
    expect(ramp[DOT_LEVELS - 1]).toBe("#ffffff");
  });

  test("falls back to the endpoints for colours it cannot parse", () => {
    const ramp = dotRamp("#94a3b824", "red");
    expect(ramp.length).toBe(DOT_LEVELS);
    expect(ramp[DOT_LEVELS - 1]).toBe("red");
  });
});
