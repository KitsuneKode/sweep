import { afterEach, describe, expect, test } from "bun:test";
import { CliRenderer } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { Meter } from "./Meter.js";
import { meterLine, meterPixels, releaseMeterImages, stackPixels } from "./meter-draw.js";

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

afterEach(() => {
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

  test("nothing to split draws nothing", () => {
    const pixels = stackPixels(40, 10, [{ fraction: 0, color: "#ff0000" }]);
    expect(pixels.every((byte) => byte === 0)).toBe(true);
  });
});
