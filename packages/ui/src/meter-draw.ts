import { NativeImage, StyledText, fg, t } from "@opentui/core";

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
      const t = cover(x0, x0 + span);
      const f = b > a ? cover(a, b) : 0;
      // Fill over track, both straight alpha.
      const alpha = f + t * (1 - f);
      const mix = (c: 0 | 1 | 2) =>
        alpha > 0 ? (fillRgb[c] * f + trackRgb[c] * t * (1 - f)) / alpha : 0;
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
}

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
  const runs: { from: number; to: number; color: [number, number, number] }[] = [];
  let at = 0;
  for (const segment of segments) {
    const share = Math.max(0, segment.fraction) / total;
    if (share <= 0) continue;
    const to = Math.min(width, Math.max(at + 1, at + share * width));
    runs.push({ from: at, to, color: rgb(segment.color) });
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
      pixels[i + 3] = Math.round(coverage * 255);
    }
  }
  return pixels;
}

/** The text stack: each cell takes the colour of the share it falls in. */
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
    if (n > 0) chunks.push(t`${fg(segment.color)("━".repeat(n))}`);
    cells += n;
  });
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
 * Images are shared by everything that draws the same pixels (row bars of
 * equal size and tone), and the oldest are released once enough newer ones
 * exist - long after any renderer still points at them.
 */
const IMAGE_CACHE_MAX = 256;
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
      setTimeout(() => oldest.dispose(), 1_000);
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
