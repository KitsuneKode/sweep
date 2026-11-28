import { NativeImage, StyledText, fg, t } from "@opentui/core";
import { allocateSegmentCells, bayerEdgeFactor } from "./dot-matrix.js";

export const EASE_MS = 180;

/** Strong ease-out: the change is visible on the first frame. */
export function easeOut(progress: number): number {
  return 1 - (1 - progress) ** 4;
}

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** The text meter: heavy line for the value, a lighter one for the preview. */
export function meterLine(
  width: number,
  value: number,
  preview: number,
  fill: string,
  previewColor: string,
  track: string,
): StyledText {
  const cells = Math.max(0, width);
  const at = (fraction: number) =>
    fraction > 0 ? Math.max(1, Math.min(cells, Math.round(fraction * cells))) : 0;
  const solid = at(value);
  const soft = Math.max(solid, at(preview));
  return t`${fg(fill)("━".repeat(solid))}${fg(previewColor)("━".repeat(soft - solid))}${fg(track)(
    "─".repeat(cells - soft),
  )}`;
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(/^#([0-9a-f]{6})/i.exec(hex)?.[1] ?? "808080", 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Pixels for the meter: three capsules (track, preview, value) composited
 * over transparency. Coverage comes from the distance to each capsule, so
 * ends are round and edges soft at any cell size.
 */
export function meterPixels(
  width: number,
  height: number,
  value: number,
  preview: number,
  fill: string,
  track: string | null,
  thickness = 0.28,
  background: string | null = null,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  // Kitty shows an image's transparent pixels in the terminal's own colour,
  // not the cell colour behind it: on a painted canvas or a highlighted row
  // the image has to carry that colour itself.
  const ground = background && /^#[0-9a-f]{6}/i.test(background) ? rgb(background) : null;
  if (ground)
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = ground[0];
      pixels[i + 1] = ground[1];
      pixels[i + 2] = ground[2];
      pixels[i + 3] = 255;
    }
  const radius = Math.max(1.25, (height * thickness) / 2);
  const cy = height / 2;
  const x0 = radius;
  const span = Math.max(0, width - 2 * radius);
  const layers: [number, [number, number, number], number][] = [
    ...(track ? [[x0 + span, rgb(track), 1] as [number, [number, number, number], number]] : []),
    [x0 + span * clamp01(Math.max(value, preview)), rgb(fill), 0.38],
    [x0 + span * clamp01(value), rgb(fill), 1],
  ];
  const trackColor = track ? layers[0]![1] : null;
  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - cy;
    if (Math.abs(dy) > radius + 1) continue;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [end, color, opacity] of layers) {
        // Nothing to draw for an empty fill: a lone dot would claim a value.
        if (end <= x0 + 0.01 && color !== trackColor) continue;
        const dx = px < x0 ? x0 - px : px > end ? px - end : 0;
        const coverage = Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(dx, dy))) * opacity;
        if (coverage <= 0) continue;
        // Straight-alpha "over".
        const out = coverage + a * (1 - coverage);
        r = (color[0] * coverage + r * a * (1 - coverage)) / out;
        g = (color[1] * coverage + g * a * (1 - coverage)) / out;
        b = (color[2] * coverage + b * a * (1 - coverage)) / out;
        a = out;
      }
      if (a <= 0) continue;
      const i = (y * width + x) * 4;
      if (ground) {
        pixels[i] = Math.round(r * a + ground[0] * (1 - a));
        pixels[i + 1] = Math.round(g * a + ground[1] * (1 - a));
        pixels[i + 2] = Math.round(b * a + ground[2] * (1 - a));
        continue;
      }
      pixels[i] = Math.round(r);
      pixels[i + 1] = Math.round(g);
      pixels[i + 2] = Math.round(b);
      pixels[i + 3] = Math.round(a * 255);
    }
  }
  return pixels;
}

/**
 * An indeterminate meter: the track, and a soft run of `fill` from `from` to
 * `to` (fractions of the width, clipped) with rounded ends.
 */
export function glidePixels(
  width: number,
  height: number,
  from: number,
  to: number,
  fill: string,
  track: string,
  thickness = 0.28,
  background: string | null = null,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const ground = background && /^#[0-9a-f]{6}/i.test(background) ? rgb(background) : null;
  const radius = Math.max(1.25, (height * thickness) / 2);
  const cy = height / 2;
  const x0 = radius;
  const span = Math.max(0, width - 2 * radius);
  const a = x0 + span * clamp01(from);
  const b = x0 + span * clamp01(to);
  const trackRgb = rgb(track);
  const fillRgb = rgb(fill);
  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - cy;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const px = x + 0.5;
      const cover = (start: number, end: number) => {
        const dx = px < start ? start - px : px > end ? px - end : 0;
        return Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(dx, dy)));
      };
      const tCov = cover(x0, x0 + span);
      const f = b > a ? cover(a, b) : 0;
      // Fill over track, both straight alpha.
      const alpha = f + tCov * (1 - f);
      const mix = (c: 0 | 1 | 2) =>
        alpha > 0 ? (fillRgb[c] * f + trackRgb[c] * tCov * (1 - f)) / alpha : 0;
      if (ground) {
        pixels[i] = Math.round(mix(0) * alpha + ground[0] * (1 - alpha));
        pixels[i + 1] = Math.round(mix(1) * alpha + ground[1] * (1 - alpha));
        pixels[i + 2] = Math.round(mix(2) * alpha + ground[2] * (1 - alpha));
        pixels[i + 3] = 255;
      } else if (alpha > 0) {
        pixels[i] = Math.round(mix(0));
        pixels[i + 1] = Math.round(mix(1));
        pixels[i + 2] = Math.round(mix(2));
        pixels[i + 3] = Math.round(alpha * 255);
      }
    }
  }
  return pixels;
}

/** The text glide: a heavy run over a light track. */
export function glideLine(
  width: number,
  from: number,
  to: number,
  fill: string,
  track: string,
): StyledText {
  const a = Math.max(0, Math.min(width, Math.round(clamp01(from) * width)));
  const b = Math.max(a, Math.min(width, Math.round(clamp01(to) * width)));
  return t`${fg(track)("─".repeat(a))}${fg(fill)("━".repeat(b - a))}${fg(track)("─".repeat(width - b))}`;
}

export interface StackSegment {
  fraction: number;
  color: string;
  /** Recede behind the segment someone is resting on. */
  dim?: boolean;
  /** Distinct Braille density glyph used under NO_COLOR. */
  noColorGlyph?: string;
}

/** How much of a dimmed segment still shows: enough to read its share, not to compete. */
export const STACK_DIM = 0.38;

/**
 * One capsule split into coloured runs, left to right, each run as long as
 * its share. A one-pixel seam of ground separates runs so neighbours of a
 * similar tone still read as two. Shares are normalised, so they need not
 * sum to one.
 */
export function stackPixels(
  width: number,
  height: number,
  segments: StackSegment[],
  thickness = 0.5,
  background: string | null = null,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const ground = background && /^#[0-9a-f]{6}/i.test(background) ? rgb(background) : null;
  if (ground)
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = ground[0];
      pixels[i + 1] = ground[1];
      pixels[i + 2] = ground[2];
      pixels[i + 3] = 255;
    }
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.fraction), 0);
  if (total <= 0) return pixels;
  const radius = Math.max(1.25, (height * thickness) / 2);
  const cy = height / 2;
  const x0 = radius;
  const x1 = width - radius;
  // Run boundaries in pixels; tiny shares still get one visible pixel.
  const runs: { from: number; to: number; color: [number, number, number]; alpha: number }[] = [];
  let at = 0;
  for (const segment of segments) {
    const share = Math.max(0, segment.fraction) / total;
    if (share <= 0) continue;
    const to = Math.min(width, Math.max(at + 1, at + share * width));
    const color = rgb(segment.color);
    // On a painted ground a dim run is mixed toward it; on transparency it
    // loses opacity instead, so either way it recedes by the same amount.
    const mixed: [number, number, number] =
      segment.dim && ground
        ? [
            Math.round(color[0] * STACK_DIM + ground[0] * (1 - STACK_DIM)),
            Math.round(color[1] * STACK_DIM + ground[1] * (1 - STACK_DIM)),
            Math.round(color[2] * STACK_DIM + ground[2] * (1 - STACK_DIM)),
          ]
        : color;
    runs.push({ from: at, to, color: mixed, alpha: segment.dim && !ground ? STACK_DIM : 1 });

    at = to;
  }
  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - cy;
    if (Math.abs(dy) > radius + 1) continue;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
      const coverage = Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(dx, dy)));
      if (coverage <= 0) continue;
      const run = runs.find((candidate) => px >= candidate.from && px < candidate.to);
      if (!run) continue;
      // The seam: the first pixel of every run after the first stays ground.
      if (run !== runs[0] && px - run.from < 1) continue;
      const i = (y * width + x) * 4;
      const [r, g, b] = run.color;
      if (ground) {
        pixels[i] = Math.round(r * coverage + ground[0] * (1 - coverage));
        pixels[i + 1] = Math.round(g * coverage + ground[1] * (1 - coverage));
        pixels[i + 2] = Math.round(b * coverage + ground[2] * (1 - coverage));
        continue;
      }
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = Math.round(coverage * run.alpha * 255);
    }
  }
  return pixels;
}

/**
 * The text stack: each cell takes the colour of the share it falls in. A dim
 * share is drawn with the lighter line, so the focus reads without any colour
 * mixing and in every terminal.
 */
export function stackLine(width: number, segments: StackSegment[]): StyledText {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.fraction), 0);
  if (width <= 0 || total <= 0) return t`${" ".repeat(Math.max(0, width))}`;
  const chunks: StyledText[] = [];
  let cells = 0;
  let acc = 0;
  segments.forEach((segment, index) => {
    acc += Math.max(0, segment.fraction) / total;
    const end = index === segments.length - 1 ? width : Math.round(acc * width);
    const n = Math.max(0, end - cells);
    if (n > 0) chunks.push(t`${fg(segment.color)((segment.dim ? "─" : "━").repeat(n))}`);
    cells += n;
  });
  return new StyledText(chunks.flatMap((chunk) => chunk.chunks));
}

export interface DotMatrixBarOptions {
  background?: string | null | undefined;
  trackColor?: string | undefined;
  dimColor?: string | undefined;
  fillFraction?: number | undefined;
  isNoColor?: boolean | undefined;
  /** Category seams are useful for composition bars, wrong for one continuous meter. */
  withSeams?: boolean | undefined;
}

const NO_COLOR_BRAILLE = ["⣿", "⣶", "⣤", "⠒", "⠿", "⡇", "⡄", "⠄", "⠛", "⠶", "⠴"] as const;

/**
 * Direction C+ Kitty RGBA dot-matrix strip: crisp 2×2 pixel dots on a 4px grid
 * with ordered 2×2 Bayer dithering at segment right edges, 1-dot ground seams
 * between buckets, unlit `trackColor` dots, and opaque `background` baking so
 * `auto` theme card surfaces never bleed through Kitty placements.
 */
export function dotMatrixPixels(
  width: number,
  height: number,
  segments: readonly StackSegment[],
  options: DotMatrixBarOptions = {},
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const ground =
    options.background && /^#[0-9a-f]{6}/i.test(options.background)
      ? rgb(options.background)
      : null;
  if (ground) {
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = ground[0];
      pixels[i + 1] = ground[1];
      pixels[i + 2] = ground[2];
      pixels[i + 3] = 255;
    }
  }
  const nonZero = segments.filter((segment) => segment.fraction > 0);
  if (width < 4 || height < 4 || nonZero.length === 0) return pixels;

  const pitch = 4;
  const dotSize = 2;
  const cols = Math.floor(width / pitch);
  const rows = Math.max(2, Math.floor((height - 2) / pitch));
  const yOff = Math.max(0, Math.floor((height - rows * pitch) / 2) + 1);
  const xOff = Math.max(0, Math.floor((width - cols * pitch) / 2));

  const frac = options.fillFraction === undefined ? 1 : clamp01(options.fillFraction);
  const litCols = Math.round(cols * frac);
  const allocated = allocateSegmentCells(nonZero, litCols, options.withSeams !== false);

  const runs: {
    from: number;
    to: number;
    seg: StackSegment;
    idx: number;
    color: [number, number, number];
  }[] = [];
  let cursor = 0;
  allocated.forEach((item, idx) => {
    runs.push({
      from: cursor,
      to: cursor + item.cells,
      seg: item.segment,
      idx,
      color: rgb(item.segment.color),
    });
    cursor += item.cells + (item.seamAfter ? 1 : 0);
  });

  const trackRgb = rgb(options.trackColor ?? "#2a2c32");
  const isNoColor = Boolean(options.isNoColor);

  const paintDot = (px: number, py: number, color: [number, number, number], alpha: number) => {
    const a = clamp01(alpha);
    for (let dy = 0; dy < dotSize && py + dy < height; dy++) {
      for (let dx = 0; dx < dotSize && px + dx < width; dx++) {
        const i = ((py + dy) * width + (px + dx)) * 4;
        if (ground) {
          pixels[i] = Math.round(color[0] * a + ground[0] * (1 - a));
          pixels[i + 1] = Math.round(color[1] * a + ground[1] * (1 - a));
          pixels[i + 2] = Math.round(color[2] * a + ground[2] * (1 - a));
          pixels[i + 3] = 255;
        } else {
          pixels[i] = color[0];
          pixels[i + 1] = color[1];
          pixels[i + 2] = color[2];
          pixels[i + 3] = Math.round(a * 255);
        }
      }
    }
  };

  for (let cx = 0; cx < cols; cx++) {
    const run = runs.find((r) => cx >= r.from && cx < r.to);
    for (let ry = 0; ry < rows; ry++) {
      const px = xOff + cx * pitch;
      const py = yOff + ry * pitch;
      if (!run) {
        // Columns inside `litCols` not claimed by a run are 1-dot ground seams.
        if (cx >= litCols) {
          paintDot(px, py, trackRgb, 0.9);
        }
        continue;
      }
      const distFromEnd = run.to - 1 - cx;
      let alpha = (run.seg.dim ? 0.3 : 1) * bayerEdgeFactor(cx, ry, distFromEnd);
      if (isNoColor) {
        if (run.idx % 4 === 1 && (cx + ry) % 4 === 0) alpha *= 0.35;
        if (run.idx % 4 === 2 && ry % 2 === 1 && cx % 2 === 0) alpha *= 0.25;
        if (run.idx % 4 === 3 && (cx + ry) % 2 === 1) alpha *= 0.2;
      }
      paintDot(px, py, run.color, alpha);
    }
  }
  return pixels;
}

/**
 * Direction C+ Braille dot-matrix fallback for non-Kitty terminals (tmux,
 * foot, Alacritty, iTerm2, Windows Terminal, and NO_COLOR). Shares segment
 * allocation with the pixel bar and keeps every non-zero share visible with
 * 1-cell seams and Bayer-inspired soft right edges (`⣿` -> `⣷`).
 */
export function dotMatrixLine(
  width: number,
  segments: readonly StackSegment[],
  options: DotMatrixBarOptions = {},
): StyledText {
  if (width <= 0) return t``;
  const frac = options.fillFraction === undefined ? 1 : clamp01(options.fillFraction);
  const activeW = Math.max(0, Math.min(width, Math.round(frac * width)));
  const unlitW = Math.max(0, width - activeW);
  const alloc = allocateSegmentCells(segments, activeW, options.withSeams !== false);
  if (alloc.length === 0) {
    return t`${fg(options.trackColor ?? "#2a2c32")("⣀".repeat(width))}`;
  }

  const isNoColor = Boolean(options.isNoColor);
  const chunks: StyledText[] = [];
  let drawn = 0;
  alloc.forEach((item, idx) => {
    const seg = item.segment;
    const n = item.cells;
    const baseGlyph = isNoColor
      ? (seg.noColorGlyph ?? NO_COLOR_BRAILLE[idx % NO_COLOR_BRAILLE.length]!)
      : seg.dim
        ? "⣀"
        : "⣿";
    const edgeGlyph = isNoColor ? baseGlyph : seg.dim ? "⠂" : "⣷";
    const text = n > 1 ? baseGlyph.repeat(n - 1) + edgeGlyph : baseGlyph;
    const color = seg.dim && options.dimColor ? options.dimColor : seg.color;
    chunks.push(t`${fg(color)(text)}`);
    drawn += n;
    if (item.seamAfter) {
      chunks.push(t` `);
      drawn += 1;
    }
  });
  const remaining = Math.max(0, width - drawn);
  if (unlitW > 0 || remaining > 0) {
    chunks.push(t`${fg(options.trackColor ?? "#2a2c32")("⣀".repeat(remaining))}`);
  }
  return new StyledText(chunks.flatMap((chunk) => chunk.chunks));
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/**
 * Size as length, in eighths of a cell: where the space is, readable before
 * a single number is. Anything above zero shows at least a sliver.
 */
export function magnitudeBar(fraction: number, width: number): string {
  const eighths = fraction > 0 ? Math.max(1, Math.round(clamp01(fraction) * width * 8)) : 0;
  const bar = "█".repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8];
  return bar + " ".repeat(Math.max(0, width - [...bar].length));
}

/**
 * Images are shared by everything that draws the same pixels, capped at 64
 * entries per `.plans/kitty-graphics.md` §4 so RSS stays flat and active bars
 * never thrash the cache. Evicted handles dispose after the next paint frame.
 */
export const IMAGE_CACHE_MAX = 64;
const imageCache = new Map<string, NativeImage>();

export function cachedImage(
  key: string,
  draw: () => Uint8Array,
  width: number,
  height: number,
): NativeImage | null {
  const hit = imageCache.get(key);
  if (hit) {
    imageCache.delete(key);
    imageCache.set(key, hit);
    return hit;
  }
  try {
    const image = NativeImage.fromRgba(draw(), width, height);
    imageCache.set(key, image);
    if (imageCache.size > IMAGE_CACHE_MAX) {
      const [oldestKey, oldest] = imageCache.entries().next().value!;
      imageCache.delete(oldestKey);
      // Not this frame: a placement may still reference it until the next render.
      const timer = setTimeout(() => oldest.dispose(), 1_000);
      timer.unref?.();
    }
    return image;
  } catch {
    return null;
  }
}

export function releaseMeterImages(): void {
  for (const image of imageCache.values()) image.dispose();
  imageCache.clear();
}
