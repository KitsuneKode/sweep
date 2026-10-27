import { NativeImage, fg, t, type StyledText } from "@opentui/core";

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
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
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
      pixels[i] = Math.round(r);
      pixels[i + 1] = Math.round(g);
      pixels[i + 2] = Math.round(b);
      pixels[i + 3] = Math.round(a * 255);
    }
  }
  return pixels;
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
