import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CliRenderer } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { canUseKittyGraphics, Meter } from "./Meter.js";
import {
  dotMatrixLine,
  dotMatrixPixels,
  IMAGE_CACHE_MAX,
  meterLine,
  meterPixels,
  releaseMeterImages,
  STACK_DIM,
  stackLine,
  stackPixels,
} from "./meter-draw.js";

const capabilities = Object.getOwnPropertyDescriptor(CliRenderer.prototype, "capabilities")!;
const resolution = Object.getOwnPropertyDescriptor(CliRenderer.prototype, "resolution")!;

function pretendKitty() {
  Object.defineProperty(CliRenderer.prototype, "capabilities", {
    configurable: true,
    get: () => ({ kitty_graphics: true }),
  });
  Object.defineProperty(CliRenderer.prototype, "resolution", {
    configurable: true,
    get: () => ({ width: 400, height: 80 }),
  });
}

const originalNoColor = process.env.NO_COLOR;

beforeEach(() => {
  delete process.env.NO_COLOR;
});

afterEach(() => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
  Object.defineProperty(CliRenderer.prototype, "capabilities", capabilities);
  Object.defineProperty(CliRenderer.prototype, "resolution", resolution);
  releaseMeterImages();
});

describe("meter", () => {
  test("draws a line of box glyphs where the terminal has no graphics", async () => {
    const setup = await testRender(
      <Meter width={20} value={0.5} fill="#cdf450" previewColor="#808080" track="#303030" />,
      { width: 20, height: 1 },
    );
    await act(async () => {
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toContain("━━━━━━━━━━──────────");
    setup.renderer.destroy();
  });

  test("draws pixels instead of glyphs in a kitty graphics terminal", async () => {
    pretendKitty();
    const setup = await testRender(
      <Meter width={20} value={0.5} fill="#cdf450" previewColor="#808080" track="#303030" />,
      { width: 20, height: 1 },
    );
    await act(async () => {
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).not.toContain("━");
    setup.renderer.destroy();
  });

  test("pixels: an empty fill draws only the track, a full one reaches the end", () => {
    const empty = meterPixels(100, 10, 0, 0, "#ffffff", "#000000");
    const full = meterPixels(100, 10, 1, 0, "#ffffff", null);
    const centre = (pixels: Uint8Array, x: number) =>
      pixels.subarray((5 * 100 + x) * 4, (5 * 100 + x) * 4 + 4);
    expect([...centre(empty, 50)]).toEqual([0, 0, 0, 255]);
    expect(centre(full, 97)[3]).toBeGreaterThan(200);
    // No track: outside the stroke stays transparent.
    expect(full[3]).toBe(0);
  });

  test("text: any value above zero shows at least one cell", () => {
    const line = meterLine(10, 0.001, 0, "#fff", "#888", "#333");
    expect(line.chunks.map((chunk) => chunk.text).join("")).toBe("━─────────");
  });
});

describe("stackPixels", () => {
  const at = (pixels: Uint8Array, width: number, x: number, y: number) =>
    Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));

  test("runs take their share of the width, separated by a seam of ground", () => {
    const width = 200;
    const height = 20;
    const pixels = stackPixels(
      width,
      height,
      [
        { fraction: 3, color: "#ff0000" },
        { fraction: 1, color: "#0000ff" },
      ],
      0.5,
      "#000000",
    );
    const mid = height / 2;
    expect(at(pixels, width, 75, mid)).toEqual([255, 0, 0, 255]);
    expect(at(pixels, width, 175, mid)).toEqual([0, 0, 255, 255]);
    // The seam where blue begins is ground, not either colour.
    expect(at(pixels, width, 150, mid)).toEqual([0, 0, 0, 255]);
    // Every pixel is opaque on a painted ground: kitty shows no box around it.
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(255);
  });

  test("a dim run recedes toward the ground and the rest keep their colour", () => {
    const width = 200;
    const height = 20;
    const pixels = stackPixels(
      width,
      height,
      [
        { fraction: 3, color: "#ff0000" },
        { fraction: 1, color: "#0000ff", dim: true },
      ],
      0.5,
      "#000000",
    );
    const mid = height / 2;
    expect(at(pixels, width, 75, mid)).toEqual([255, 0, 0, 255]);
    expect(at(pixels, width, 175, mid)).toEqual([0, 0, Math.round(255 * STACK_DIM), 255]);
  });

  test("a dim run on transparency loses opacity, not colour", () => {
    const width = 200;
    const height = 20;
    const pixels = stackPixels(width, height, [
      { fraction: 1, color: "#ff0000" },
      { fraction: 1, color: "#0000ff", dim: true },
    ]);
    const mid = height / 2;
    expect(at(pixels, width, 50, mid)[3]).toBe(255);
    expect(at(pixels, width, 150, mid)).toEqual([0, 0, 255, Math.round(255 * STACK_DIM)]);
  });

  test("text: a dim share is the lighter line", () => {
    const line = stackLine(10, [
      { fraction: 1, color: "#ff0000" },
      { fraction: 1, color: "#0000ff", dim: true },
    ]);
    expect(line.chunks.map((chunk) => chunk.text).join("")).toBe("━━━━━─────");
  });

  test("nothing to split draws nothing", () => {
    const pixels = stackPixels(40, 10, [{ fraction: 0, color: "#ff0000" }]);
    expect(pixels.every((byte) => byte === 0)).toBe(true);
  });
});

describe("C+ dot-matrix bar and Kitty gating", () => {
  test("canUseKittyGraphics disables Kitty in tmux, Zellij, Screen, NO_COLOR, and SWEEP_GRAPHICS=off", () => {
    const caps = { kitty_graphics: true, multiplexer: "none" };
    const res = { width: 1000, height: 600 };
    expect(canUseKittyGraphics(caps, res, 100, 30, {})).toBe(true);
    expect(
      canUseKittyGraphics({ kitty_graphics: true, multiplexer: "tmux" }, res, 100, 30, {}),
    ).toBe(false);
    expect(canUseKittyGraphics(caps, res, 100, 30, { TMUX: "/tmp/tmux-1000/default,1,0" })).toBe(
      false,
    );
    expect(canUseKittyGraphics(caps, res, 100, 30, { ZELLIJ: "0" })).toBe(false);
    expect(canUseKittyGraphics(caps, res, 100, 30, { STY: "1234.pts" })).toBe(false);
    expect(canUseKittyGraphics(caps, res, 100, 30, { NO_COLOR: "1" })).toBe(false);
    expect(canUseKittyGraphics(caps, res, 100, 30, { SWEEP_GRAPHICS: "off" })).toBe(false);
    expect(canUseKittyGraphics(caps, res, 100, 30, { OPENTUI_GRAPHICS: "false" })).toBe(false);
    expect(IMAGE_CACHE_MAX).toBeLessThanOrEqual(64);
  });

  test("dotMatrixPixels bakes opaque ground and draws distinct segments with seams", () => {
    const pixels = dotMatrixPixels(
      200,
      20,
      [
        { fraction: 3, color: "#55d7be" },
        { fraction: 1, color: "#ad9efd" },
      ],
      { background: "#1b1c1f", trackColor: "#2a2c32" },
    );
    expect(pixels.length).toBe(200 * 20 * 4);
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(255);
  });

  test("dotMatrixLine renders Braille dots with seams and distinct NO_COLOR patterns", () => {
    const colored = dotMatrixLine(20, [
      { fraction: 2, color: "#55d7be", noColorGlyph: "⣿" },
      { fraction: 1, color: "#ad9efd", noColorGlyph: "⣶" },
    ]);
    const coloredText = colored.chunks.map((c) => c.text).join("");
    expect(coloredText.length).toBe(20);
    expect(coloredText).toContain("⣿");
    expect(coloredText).toContain("⣷");
    expect(coloredText).toContain(" ");

    const noColor = dotMatrixLine(
      20,
      [
        { fraction: 2, color: "#d0d0d0", noColorGlyph: "⣿" },
        { fraction: 1, color: "#f5f5f5", noColorGlyph: "⣶" },
      ],
      { isNoColor: true },
    );
    const noColorText = noColor.chunks.map((c) => c.text).join("");
    expect(noColorText).toContain("⣿");
    expect(noColorText).toContain("⣶");
  });

  test("dotMatrixPixels and dotMatrixLine both keep a tiny trailing category visible (parity)", () => {
    const segments = [
      { fraction: 205, color: "#00ff00", noColorGlyph: "⣿" },
      { fraction: 1, color: "#0000ff", noColorGlyph: "⣶" },
    ];
    // Braille fallback keeps both segments visible.
    const line = dotMatrixLine(50, segments);
    expect(
      line.chunks.filter((chunk) => chunk.text.trim().length > 0).length,
    ).toBeGreaterThanOrEqual(2);

    // Kitty pixel renderer (400×22 = 100 dot columns) must also paint the tiny trailing blue segment.
    const pixels = dotMatrixPixels(400, 22, segments, {
      background: "#000000",
      trackColor: "#222222",
    });
    let greenPixels = 0;
    let bluePixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i]!;
      const g = pixels[i + 1]!;
      const b = pixels[i + 2]!;
      if (g > 100 && b < 40 && r < 40) greenPixels += 1;
      if (b > 100 && g < 40 && r < 40) bluePixels += 1;
    }
    expect(greenPixels).toBeGreaterThan(0);
    expect(bluePixels).toBeGreaterThan(0);
  });
});
