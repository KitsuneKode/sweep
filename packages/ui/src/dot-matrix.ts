/**
 * Dot-matrix loaders, after dot-matrix-animations.vercel.app.
 *
 * Same construction as the reference: a fixed grid of dots, one shared pulse
 * curve, and a per-dot delay map. Nothing moves — every dot sits still and only
 * its brightness animates, which is what keeps the figure readable at 5x5 and
 * costs nothing to redraw in a terminal.
 */

export const DOT_GRID = 5;

/** Brightness steps a dot can take, dimmest first. */
export const DOT_LEVELS = 4;

export type DotPattern = "pulseRings" | "wave" | "scan" | "spiral";

/** Frames in one full cycle. At 16fps this is a ~1.5s loop. */
export const DOT_CYCLE = 24;

/**
 * Delay map: how far into the cycle this dot lights up, in `[0, 1)`.
 * The pattern lives entirely in this function.
 */
export function dotDelay(pattern: DotPattern, x: number, y: number): number {
  const mid = (DOT_GRID - 1) / 2;

  switch (pattern) {
    case "pulseRings": {
      // Chebyshev distance from centre — concentric squares breathing outward.
      const ring = Math.max(Math.abs(x - mid), Math.abs(y - mid));
      return (ring / (mid + 1)) % 1;
    }
    case "wave": {
      // Diagonal sweep, top-left to bottom-right.
      return ((x + y) / (2 * (DOT_GRID - 1) + 1)) % 1;
    }
    case "scan": {
      // Column sweep; whole column lights at once.
      return (x / DOT_GRID) % 1;
    }
    case "spiral": {
      // Angle around the centre, so light chases around the ring.
      const angle = Math.atan2(y - mid, x - mid);
      return ((angle + Math.PI) / (2 * Math.PI)) % 1;
    }
  }
}

/**
 * Shared pulse curve: a dot flares at its delay, then decays.
 * `phase` is `[0, 1)`; returns `[0, 1]`.
 */
export function dotPulse(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  // Fast attack, slow release — reads as a blink rather than a sine throb.
  if (p < 0.18) return p / 0.18;
  if (p < 0.62) return 1 - (p - 0.18) / 0.44;
  return 0;
}

/**
 * Brightness level `0..DOT_LEVELS-1` for one dot on one frame.
 * Level 0 is the resting dot: the grid never goes fully dark.
 */
export function dotLevel(pattern: DotPattern, x: number, y: number, frame: number): number {
  const t = (frame % DOT_CYCLE) / DOT_CYCLE;
  const intensity = dotPulse(t - dotDelay(pattern, x, y));
  return Math.min(DOT_LEVELS - 1, Math.round(intensity * (DOT_LEVELS - 1)));
}

/** Full grid of brightness levels, row-major, for one frame. */
export function dotFrame(pattern: DotPattern, frame: number): number[][] {
  const rows: number[][] = [];
  for (let y = 0; y < DOT_GRID; y++) {
    const row: number[] = [];
    for (let x = 0; x < DOT_GRID; x++) row.push(dotLevel(pattern, x, y, frame));
    rows.push(row);
  }
  return rows;
}

/** One-row variant for the statusline, same curve and delay map. */
export function dotStrip(pattern: DotPattern, frame: number, width: number): number[] {
  const t = (frame % DOT_CYCLE) / DOT_CYCLE;
  const levels: number[] = [];
  for (let x = 0; x < width; x++) {
    const delay = (x / width) % 1;
    const intensity = dotPulse(t - (pattern === "scan" ? delay : delay * 0.8));
    levels.push(Math.min(DOT_LEVELS - 1, Math.round(intensity * (DOT_LEVELS - 1))));
  }
  return levels;
}

/** Parse `#rrggbb` into channels. Returns null for anything else. */
function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function toHex(channels: [number, number, number]): string {
  return `#${channels.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Brightness ramp from `dim` to `bright`, `DOT_LEVELS` entries long.
 * Falls back to the endpoints when either colour is not plain `#rrggbb`.
 */
export function dotRamp(dim: string, bright: string): string[] {
  const from = parseHex(dim);
  const to = parseHex(bright);
  if (!from || !to) {
    return Array.from({ length: DOT_LEVELS }, (_, i) => (i === DOT_LEVELS - 1 ? bright : dim));
  }

  return Array.from({ length: DOT_LEVELS }, (_, i) => {
    const ratio = i / (DOT_LEVELS - 1);
    return toHex([
      from[0] + (to[0] - from[0]) * ratio,
      from[1] + (to[1] - from[1]) * ratio,
      from[2] + (to[2] - from[2]) * ratio,
    ]);
  });
}
