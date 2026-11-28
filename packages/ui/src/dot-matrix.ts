/**
 * Dot-matrix loaders and C+ dot-matrix bar helpers.
 *
 * Loaders use a fixed grid, shared pulse curve and per-dot delay map. Only
 * brightness changes; widgets own the timer and reduced-motion preference.
 *
 * The C+ dot-matrix storage bar shares `BAYER_2X2`, `bayerEdgeFactor`, and
 * `allocateSegmentCells` across both the Kitty pixel renderer and the Braille
 * text fallback so segment boundaries and seams stay consistent.
 */

export const DOT_GRID = 5;

/** Brightness steps a dot can take, dimmest first. */
export const DOT_LEVELS = 4;

export type DotPattern = "pulseRings" | "wave" | "scan" | "spiral";

/** Frames in one cycle. With the widget's 160 ms step, a cycle takes 3.84 s. */
export const DOT_CYCLE = 24;

/** Ordered 2×2 Bayer dither matrix for crisp edge transitions on C+ dot bars. */
export const BAYER_2X2: readonly [readonly [number, number], readonly [number, number]] = [
  [0, 2],
  [3, 1],
];

/**
 * Brightness multiplier for a dot near a segment's right edge (`distFromEnd`:
 * 0 = final dot column, 1 = penultimate column, >= 2 = interior).
 */
export function bayerEdgeFactor(col: number, row: number, distFromEnd: number): number {
  const threshold = BAYER_2X2[Math.abs(row) % 2]![Math.abs(col) % 2]!;
  if (distFromEnd === 0 && threshold >= 2) return 0.42;
  if (distFromEnd === 1 && threshold === 3) return 0.72;
  return 1;
}

export interface AllocatedSegment<T extends { fraction: number }> {
  segment: T;
  cells: number;
  seamAfter: boolean;
}

/**
 * Allocate integer cell counts across non-zero segments with min 1 cell per
 * segment (when width permits) and optional 1-cell seams between adjacent runs.
 */
export function allocateSegmentCells<T extends { fraction: number }>(
  segments: readonly T[],
  totalWidth: number,
  withSeams = true,
): AllocatedSegment<T>[] {
  const nonZero = segments.filter((segment) => segment.fraction > 0);
  if (nonZero.length === 0 || totalWidth <= 0) return [];
  const seamCount = withSeams && totalWidth >= nonZero.length * 3 ? nonZero.length - 1 : 0;
  const usable = Math.max(nonZero.length, totalWidth - seamCount);
  const sum = nonZero.reduce((acc, segment) => acc + segment.fraction, 0);
  const raw = nonZero.map((segment) => (segment.fraction / sum) * usable);
  const cells = raw.map((value) => Math.max(1, Math.floor(value)));
  let used = cells.reduce((a, b) => a + b, 0);

  while (used < usable) {
    let bestIdx = 0;
    let bestRem = -1;
    for (let i = 0; i < raw.length; i++) {
      const rem = raw[i]! - cells[i]!;
      if (rem > bestRem) {
        bestRem = rem;
        bestIdx = i;
      }
    }
    cells[bestIdx] = cells[bestIdx]! + 1;
    used += 1;
  }

  while (used > usable) {
    let maxIdx = 0;
    for (let i = 1; i < cells.length; i++) {
      if (cells[i]! > cells[maxIdx]!) maxIdx = i;
    }
    if (cells[maxIdx]! <= 1) break;
    cells[maxIdx] = cells[maxIdx]! - 1;
    used -= 1;
  }

  // If totalWidth < nonZero.length, trim from the smallest segments so output never overflows.
  while (used > totalWidth && cells.length > 0) {
    let minIdx = 0;
    for (let i = 1; i < cells.length; i++) {
      if (
        cells[i]! > 0 &&
        (cells[minIdx]! === 0 || nonZero[i]!.fraction < nonZero[minIdx]!.fraction)
      ) {
        minIdx = i;
      }
    }
    if (cells[minIdx]! <= 0) break;
    cells[minIdx] = cells[minIdx]! - 1;
    used -= 1;
  }

  const kept: AllocatedSegment<T>[] = [];
  for (let i = 0; i < nonZero.length; i++) {
    const count = cells[i]!;
    if (count > 0) {
      kept.push({ segment: nonZero[i]!, cells: count, seamAfter: false });
    }
  }
  if (seamCount > 0) {
    for (let i = 0; i < kept.length - 1; i++) {
      kept[i]!.seamAfter = true;
    }
  }
  return kept;
}

/**
 * Delay map: how far into the cycle this dot lights up, in `[0, 1)`.
 * The pattern lives entirely in this function.
 */
export function dotDelay(pattern: DotPattern, x: number, y: number): number {
  const mid = (DOT_GRID - 1) / 2;

  switch (pattern) {
    case "pulseRings": {
      // Chebyshev distance from centre - concentric squares breathing outward.
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
  // Fast attack, slow release - reads as a blink rather than a sine throb.
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
