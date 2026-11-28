import { Writable } from "node:stream";
import type { ColorDepth } from "./theme.js";

/**
 * Reference RGB values for the standard 16 ANSI colours (indices 0..15).
 * Calibrated so blue accents (`#60a5fa`, `#5faaff`) land on bright blue (12)
 * rather than bright cyan (14), while dark blue selections (`#1e3a5f`) land on
 * standard blue (4).
 */
const ANSI16_PALETTE: readonly [number, number, number][] = [
  [0, 0, 0], // 0: black
  [170, 0, 0], // 1: red
  [0, 170, 0], // 2: green
  [170, 110, 0], // 3: yellow
  [32, 64, 136], // 4: blue
  [170, 0, 170], // 5: magenta
  [0, 170, 170], // 6: cyan
  [178, 178, 178], // 7: white (light gray)
  [85, 85, 85], // 8: bright black (dark gray)
  [255, 92, 92], // 9: bright red
  [85, 235, 85], // 10: bright green
  [250, 225, 80], // 11: bright yellow
  [88, 148, 255], // 12: bright blue
  [235, 110, 235], // 13: bright magenta
  [80, 230, 230], // 14: bright cyan
  [255, 255, 255], // 15: bright white
];

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function colorDistSq(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  // Redmean perceptual weighting keeps distinct hues separated cleanly.
  const rMean = (r1 + r2) * 0.5;
  return (2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db;
}

/** Convert an xterm-256 index (`0..255`) to its nominal `[r, g, b]` triple. */
export function ansi256ToRgb(index: number): [number, number, number] {
  const idx = clampByte(index);
  if (idx < 16) return ANSI16_PALETTE[idx]!;
  if (idx >= 232) {
    const gray = 8 + (idx - 232) * 10;
    return [gray, gray, gray];
  }
  const offset = idx - 16;
  const ri = Math.floor(offset / 36);
  const gi = Math.floor((offset % 36) / 6);
  const bi = offset % 6;
  return [CUBE_LEVELS[ri]!, CUBE_LEVELS[gi]!, CUBE_LEVELS[bi]!];
}

/** Map an RGB colour to the nearest xterm-256 palette index (`16..255`). */
export function rgbToAnsi256(r: number, g: number, b: number): number {
  const cr = clampByte(r);
  const cg = clampByte(g);
  const cb = clampByte(b);

  const nearestCubeIndex = (v: number): number => {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < CUBE_LEVELS.length; i++) {
      const d = Math.abs(v - CUBE_LEVELS[i]!);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  };

  const ri = nearestCubeIndex(cr);
  const gi = nearestCubeIndex(cg);
  const bi = nearestCubeIndex(cb);
  const cubeIdx = 16 + 36 * ri + 6 * gi + bi;
  const cubeDist = colorDistSq(cr, cg, cb, CUBE_LEVELS[ri]!, CUBE_LEVELS[gi]!, CUBE_LEVELS[bi]!);

  const grayAvg = (cr + cg + cb) / 3;
  const grayStep = Math.max(0, Math.min(23, Math.round((grayAvg - 8) / 10)));
  const grayVal = 8 + grayStep * 10;
  const grayIdx = 232 + grayStep;
  const grayDist = colorDistSq(cr, cg, cb, grayVal, grayVal, grayVal);

  return grayDist < cubeDist ? grayIdx : cubeIdx;
}

/** Map an RGB colour to the nearest ANSI-16 colour index (`0..15`). */
export function rgbToAnsi16(r: number, g: number, b: number): number {
  const cr = clampByte(r);
  const cg = clampByte(g);
  const cb = clampByte(b);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ANSI16_PALETTE.length; i++) {
    const [pr, pg, pb] = ANSI16_PALETTE[i]!;
    const dist = colorDistSq(cr, cg, cb, pr, pg, pb);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function ansi16FgCode(index: number): string {
  return index < 8 ? String(30 + index) : String(90 + (index - 8));
}

function ansi16BgCode(index: number): string {
  return index < 8 ? String(40 + index) : String(100 + (index - 8));
}

/**
 * In `NO_COLOR` mode, normal canvas/surface backgrounds sit at the extreme ends
 * of luminance (`<= 40` on dark, `>= 222` on light) while active highlight fills
 * (`selectionBg`, solid `accent` chips) sit in the middle band (`46..216`).
 * Mapping those highlights to reverse video (`7`/`27`) keeps selection and focus
 * legible without emitting any foreground or background colour SGR codes.
 */
function isNoColorHighlightBg(r: number, g: number, b: number): boolean {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma >= 46 && luma <= 216;
}

interface ParsedExtendedColor {
  kind: "rgb" | "256";
  r: number;
  g: number;
  b: number;
  index: number;
  consumed: number;
}

/** Parse semicolon (`38;2;r;g;b`, `38;5;n`) or colon (`38:2::r:g:b`, `38:5:n`) forms. */
function parseExtendedColor(parts: string[], start: number): ParsedExtendedColor | null {
  const token = parts[start] ?? "";
  if (token.includes(":")) {
    const sub = token.split(":");
    const mode = Number(sub[1]);
    if (mode === 5 && sub.length >= 3) {
      const idx = clampByte(Number(sub[2]));
      const [r, g, b] = ansi256ToRgb(idx);
      return { kind: "256", r, g, b, index: idx, consumed: 1 };
    }
    if (mode === 2) {
      // ISO 8613-3 allows optional colours-space ID: 38:2:cs:r:g:b or 38:2:r:g:b
      const offset = sub.length >= 6 ? 3 : 2;
      if (sub.length >= offset + 3) {
        const r = clampByte(Number(sub[offset]));
        const g = clampByte(Number(sub[offset + 1]));
        const b = clampByte(Number(sub[offset + 2]));
        return { kind: "rgb", r, g, b, index: 0, consumed: 1 };
      }
    }
    return null;
  }

  const mode = Number(parts[start + 1]);
  if (mode === 5 && start + 2 < parts.length) {
    const idx = clampByte(Number(parts[start + 2]));
    const [r, g, b] = ansi256ToRgb(idx);
    return { kind: "256", r, g, b, index: idx, consumed: 3 };
  }
  if (mode === 2 && start + 4 < parts.length) {
    const r = clampByte(Number(parts[start + 2]));
    const g = clampByte(Number(parts[start + 3]));
    const b = clampByte(Number(parts[start + 4]));
    return { kind: "rgb", r, g, b, index: 0, consumed: 5 };
  }
  return null;
}

interface SgrState {
  reverseFromBg: boolean;
}

function rewriteSgr(params: string, depth: ColorDepth, state: SgrState): string {
  if (depth === "truecolor") return `\x1b[${params}m`;
  if (params === "") {
    state.reverseFromBg = false;
    return "\x1b[m";
  }

  const parts = params.split(";");
  const out: string[] = [];

  for (let i = 0; i < parts.length;) {
    const raw = parts[i] ?? "";
    const lead = Number(raw.includes(":") ? raw.split(":")[0] : raw);

    if (raw === "" || lead === 0) {
      state.reverseFromBg = false;
      out.push(raw === "" ? "0" : raw);
      i += 1;
      continue;
    }

    // Extended fg (38), bg (48), or underline colour (58)
    if (lead === 38 || lead === 48 || lead === 58) {
      const parsed = parseExtendedColor(parts, i);
      if (parsed) {
        if (depth === "256") {
          if (parsed.kind === "rgb") {
            out.push(`${lead};5;${rgbToAnsi256(parsed.r, parsed.g, parsed.b)}`);
          } else {
            out.push(`${lead};5;${parsed.index}`);
          }
        } else if (depth === "16") {
          if (lead !== 58) {
            const idx =
              parsed.kind === "256" && parsed.index < 16
                ? parsed.index
                : rgbToAnsi16(parsed.r, parsed.g, parsed.b);
            out.push(lead === 38 ? ansi16FgCode(idx) : ansi16BgCode(idx));
          }
        } else if (depth === "none") {
          if (lead === 48) {
            const highlight = isNoColorHighlightBg(parsed.r, parsed.g, parsed.b);
            if (highlight && !state.reverseFromBg) {
              out.push("7");
              state.reverseFromBg = true;
            } else if (!highlight && state.reverseFromBg) {
              out.push("27");
              state.reverseFromBg = false;
            }
          }
          // Strip fg (38) and underline colour (58) completely.
        }
        i += parsed.consumed;
        continue;
      }
      // Malformed extended colour parameter: drop safely rather than leaking.
      i += 1;
      continue;
    }

    if (depth === "none") {
      // Strip standard/bright fg, bg, default fg/bg, and underline colour reset.
      if ((lead >= 30 && lead <= 37) || lead === 39 || lead === 59 || (lead >= 90 && lead <= 97)) {
        i += 1;
        continue;
      }
      if ((lead >= 40 && lead <= 47) || (lead >= 100 && lead <= 107)) {
        const idx = lead >= 100 ? lead - 100 + 8 : lead - 40;
        const [r, g, b] = ANSI16_PALETTE[idx]!;
        const highlight = isNoColorHighlightBg(r, g, b);
        if (highlight && !state.reverseFromBg) {
          out.push("7");
          state.reverseFromBg = true;
        } else if (!highlight && state.reverseFromBg) {
          out.push("27");
          state.reverseFromBg = false;
        }
        i += 1;
        continue;
      }
      if (lead === 49) {
        if (state.reverseFromBg) {
          out.push("27");
          state.reverseFromBg = false;
        }
        i += 1;
        continue;
      }
      if (lead === 7 || lead === 27) {
        state.reverseFromBg = false;
      }
      out.push(raw);
      i += 1;
      continue;
    }

    if (depth === "16" && lead === 59) {
      i += 1;
      continue;
    }

    out.push(raw);
    i += 1;
  }

  // If every parameter in a non-empty SGR sequence was stripped (e.g. a
  // colour-only sequence under NO_COLOR), emit nothing rather than `\x1b[m`
  // which would unexpectedly reset bold/reverse/underline attributes.
  if (out.length === 0) return "";
  return `\x1b[${out.join(";")}m`;
}

const MAX_PENDING_CSI_BYTES = 256;

export interface AnsiColorDepthTransformer {
  push(chunk: string): string;
  flush(): string;
}

/**
 * Stateful streaming SGR rewriter that enforces `depth` across arbitrary chunk
 * boundaries without disturbing cursor, alternate-screen, mouse, OSC, or APC
 * control sequences.
 */
export function createAnsiColorDepthTransformer(depth: ColorDepth): AnsiColorDepthTransformer {
  let carry = "";
  const state: SgrState = { reverseFromBg: false };

  return {
    push(chunk: string): string {
      if (depth === "truecolor") return chunk;
      if (chunk.length === 0) return "";
      const input = carry + chunk;
      carry = "";

      let result = "";
      let cursor = 0;

      while (cursor < input.length) {
        const esc = input.indexOf("\x1b", cursor);
        if (esc === -1) {
          result += input.slice(cursor);
          break;
        }
        if (esc > cursor) {
          result += input.slice(cursor, esc);
        }

        // Trailing bare ESC: wait for the next chunk.
        if (esc + 1 >= input.length) {
          carry = "\x1b";
          break;
        }

        const next = input.charCodeAt(esc + 1);
        if (next !== 0x5b /* '[' */) {
          result += input.slice(esc, esc + 2);
          cursor = esc + 2;
          continue;
        }

        // Scan CSI parameter + intermediate bytes (0x20..0x3f) until final byte (0x40..0x7e).
        let pos = esc + 2;
        while (pos < input.length) {
          const code = input.charCodeAt(pos);
          if (code >= 0x40 && code <= 0x7e) break;
          if (code < 0x20 || code > 0x3f) break;
          pos += 1;
        }

        if (pos >= input.length) {
          const tail = input.slice(esc);
          if (tail.length <= MAX_PENDING_CSI_BYTES) {
            carry = tail;
          } else {
            result += tail;
          }
          break;
        }

        const finalByte = input.charCodeAt(pos);
        if (finalByte === 0x6d /* 'm' */) {
          const params = input.slice(esc + 2, pos);
          result += rewriteSgr(params, depth, state);
        } else {
          result += input.slice(esc, pos + 1);
        }
        cursor = pos + 1;
      }

      return result;
    },
    flush(): string {
      if (!carry) return "";
      const remaining = carry;
      carry = "";
      return remaining;
    },
  };
}

/** Pure single-shot SGR rewrite helper for tests and utilities. */
export function transformAnsiColorDepth(input: string, depth: ColorDepth): string {
  const transformer = createAnsiColorDepthTransformer(depth);
  return transformer.push(input) + transformer.flush();
}

export type ColorDepthOutputStream = NodeJS.WriteStream & {
  flushPending(): void;
};

/**
 * Wrap a TTY `WriteStream` so every ANSI frame written by OpenTUI's native
 * session is downsampled or stripped to `depth` before hitting the PTY.
 * Preserves TTY dimension getters and backpressure semantics.
 */
export function createColorDepthOutputStream(
  target: NodeJS.WriteStream,
  depth: ColorDepth,
): ColorDepthOutputStream {
  const transformer = createAnsiColorDepthTransformer(depth);
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
            ? decoder.decode(chunk, { stream: true })
            : String(chunk);
      const transformed = transformer.push(text);
      if (transformed.length === 0) {
        callback();
        return;
      }
      target.write(transformed, "utf8", (err) => {
        callback(err ?? undefined);
      });
    },
  });

  const flushPending = () => {
    const tail = decoder.decode() + transformer.flush();
    if (tail.length > 0 && target.writable && !target.destroyed) {
      target.write(tail);
    }
  };

  Object.defineProperties(stream, {
    isTTY: {
      enumerable: true,
      get: () => target.isTTY,
    },
    columns: {
      enumerable: true,
      get: () => target.columns,
    },
    rows: {
      enumerable: true,
      get: () => target.rows,
    },
    getWindowSize: {
      value: () =>
        typeof target.getWindowSize === "function"
          ? target.getWindowSize()
          : [target.columns || 80, target.rows || 24],
    },
    hasColors: {
      value: (count?: number) => {
        if (depth === "none") return false;
        if (depth === "16") return (count ?? 16) <= 16;
        if (depth === "256") return (count ?? 256) <= 256;
        return typeof target.hasColors === "function" ? target.hasColors(count) : true;
      },
    },
    getColorDepth: {
      value: () => {
        if (depth === "none") return 1;
        if (depth === "16") return 4;
        if (depth === "256") return 8;
        return 24;
      },
    },
    flushPending: {
      value: flushPending,
    },
  });

  return stream as unknown as ColorDepthOutputStream;
}
