import { Writable } from "node:stream";
import { describe, expect, test } from "bun:test";
import {
  ansi256ToRgb,
  createAnsiColorDepthTransformer,
  createColorDepthOutputStream,
  rgbToAnsi16,
  rgbToAnsi256,
  transformAnsiColorDepth,
} from "./ansi-color-depth.js";

const ESC = String.fromCharCode(0x1b);
const COLOR_SGR_RE = new RegExp(`${ESC}\\[[0-9;:]*m`, "g");
const TRUECOLOR_SGR_RE = new RegExp(`${ESC}\\[[0-9;:]*\\b(?:38|48|58)[;:]2[;:]`);
const COLOR256_SGR_RE = new RegExp(`${ESC}\\[[0-9;:]*\\b(?:38|48|58)[;:]5[;:]`);

function extractSgrCodes(ansi: string): string[] {
  return ansi.match(COLOR_SGR_RE) ?? [];
}

function hasTruecolorSgr(ansi: string): boolean {
  return TRUECOLOR_SGR_RE.test(ansi);
}

function has256ColorSgr(ansi: string): boolean {
  return COLOR256_SGR_RE.test(ansi);
}

function hasAnyColorSgr(ansi: string): boolean {
  for (const seq of extractSgrCodes(ansi)) {
    const inner = seq.slice(2, -1);
    if (!inner) continue;
    for (const part of inner.split(";")) {
      const lead = Number(part.includes(":") ? part.split(":")[0] : part);
      if (
        (lead >= 30 && lead <= 39) ||
        (lead >= 40 && lead <= 49) ||
        lead === 58 ||
        lead === 59 ||
        (lead >= 90 && lead <= 97) ||
        (lead >= 100 && lead <= 107)
      ) {
        return true;
      }
    }
  }
  return false;
}

describe("ansi-color-depth", () => {
  test("truecolor passes SGR sequences through unchanged", () => {
    const sample = "\x1b[1;38;2;96;165;250;48;2;36;54;82mhello\x1b[0m";
    expect(transformAnsiColorDepth(sample, "truecolor")).toBe(sample);
  });

  test("256-color downsamples truecolor SGR to 38;5 / 48;5 with zero 24-bit codes", () => {
    const sample =
      "\x1b[1;38;2;96;165;250;48;2;36;54;82mfocused\x1b[38:2::106:213:139m safe\x1b[38;5;246m muted\x1b[0m";
    const out = transformAnsiColorDepth(sample, "256");
    expect(hasTruecolorSgr(out)).toBe(false);
    expect(has256ColorSgr(out)).toBe(true);
    expect(out).toContain("\x1b[1;38;5;");
    expect(out).toContain("48;5;");
    expect(out).toContain("\x1b[38;5;246m");
    expect(out).toContain("focused");
    expect(out).toContain("safe");
    expect(out).toContain("muted");
  });

  test("16-color downsamples truecolor and 256-color SGR to basic ANSI-16 codes only", () => {
    const sample =
      "\x1b[1;38;2;95;170;255;48;2;30;58;95mselected\x1b[38;5;246;48;5;234m muted\x1b[38;2;255;102;102m danger\x1b[0m";
    const out = transformAnsiColorDepth(sample, "16");
    expect(hasTruecolorSgr(out)).toBe(false);
    expect(has256ColorSgr(out)).toBe(false);
    // Bright blue accent (94) on dark blue selection (44)
    expect(out).toContain("\x1b[1;94;44mselected");
    // Bright red danger (91)
    expect(out).toContain("\x1b[91m danger");
    // Preserves non-SGR CSI cursor controls untouched
    const withCursor = "\x1b[2J\x1b[1;1H\x1b[38;2;95;170;255mhi\x1b[0m";
    expect(transformAnsiColorDepth(withCursor, "16")).toBe("\x1b[2J\x1b[1;1H\x1b[94mhi\x1b[0m");
  });

  test("NO_COLOR (depth none) emits zero fg/bg color SGR and preserves bold/underline/reverse hierarchy", () => {
    const sample =
      "\x1b[48;2;10;10;10;38;2;245;245;245mcanvas \x1b[1;38;2;245;245;245;48;2;58;58;58mselected\x1b[22;48;2;10;10;10;38;2;170;170;170m rest\x1b[4m link\x1b[0m";
    const out = transformAnsiColorDepth(sample, "none");
    expect(hasAnyColorSgr(out)).toBe(false);
    // Canvas fg+bg only sequence is omitted completely (no accidental \x1b[m reset)
    expect(out.startsWith("canvas ")).toBe(true);
    // Selection highlight bg (#3a3a3a) becomes reverse video (7), bold (1) preserved
    expect(out).toContain("\x1b[1;7mselected");
    // Leaving highlight bg emits reverse-off (27) while keeping 22
    expect(out).toContain("\x1b[22;27m rest");
    // Underline preserved
    expect(out).toContain("\x1b[4m link\x1b[0m");
  });

  test("streaming transformer handles SGR sequences split across arbitrary chunk boundaries", () => {
    const full = "\x1b[1;38;2;95;170;255;48;2;30;58;95mchunked\x1b[0m";
    const expected = transformAnsiColorDepth(full, "16");

    const transformer = createAnsiColorDepthTransformer("16");
    let assembled = "";
    for (let i = 0; i < full.length; i += 3) {
      assembled += transformer.push(full.slice(i, i + 3));
    }
    assembled += transformer.flush();
    expect(assembled).toBe(expected);
  });

  test("color conversion helpers map representative palette tones accurately", () => {
    expect(rgbToAnsi16(95, 170, 255)).toBe(12); // bright blue
    expect(rgbToAnsi16(30, 58, 95)).toBe(4); // dark blue
    expect(rgbToAnsi16(255, 102, 102)).toBe(9); // bright red
    expect(rgbToAnsi16(85, 224, 85)).toBe(10); // bright green
    expect(rgbToAnsi16(0, 0, 0)).toBe(0); // black
    expect(rgbToAnsi16(255, 255, 255)).toBe(15); // bright white

    const idx = rgbToAnsi256(96, 165, 250);
    expect(idx).toBeGreaterThanOrEqual(16);
    expect(idx).toBeLessThanOrEqual(231);
    const [r, g, b] = ansi256ToRgb(idx);
    expect(b).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(r);
  });

  test("createColorDepthOutputStream transforms written chunks and proxies TTY properties", async () => {
    let captured = "";
    const target = new Writable({
      write(chunk, _enc, cb) {
        captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    Object.defineProperties(target, {
      isTTY: { value: true },
      columns: { value: 120 },
      rows: { value: 40 },
    });

    const wrapped = createColorDepthOutputStream(target, "16");
    expect(wrapped.isTTY).toBe(true);
    expect(wrapped.columns).toBe(120);
    expect(wrapped.rows).toBe(40);
    expect(wrapped.getColorDepth()).toBe(4);
    expect(wrapped.hasColors(16)).toBe(true);
    expect(wrapped.hasColors(256)).toBe(false);

    await new Promise<void>((resolve, reject) => {
      wrapped.write(Buffer.from("\x1b[38;2;95;170;255mhello\x1b[0m"), (err) =>
        err ? reject(err) : resolve(),
      );
    });
    wrapped.flushPending();
    expect(captured).toBe("\x1b[94mhello\x1b[0m");
  });
});
