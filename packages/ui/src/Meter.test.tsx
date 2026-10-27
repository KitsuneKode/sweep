import { afterEach, describe, expect, test } from "bun:test";
import { CliRenderer } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { Meter } from "./Meter.js";
import { meterLine, meterPixels, releaseMeterImages } from "./meter-draw.js";

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
