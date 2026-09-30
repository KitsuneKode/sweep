const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Anything touched within this window is probably still in use. */
export const RECENT_WINDOW_MS = 7 * DAY_MS;

/** Width of the widest label this module produces (`11mo`, `12d`, `10y`). */
export const AGE_LABEL_WIDTH = 4;

/**
 * Compact age of a timestamp: `5m`, `3h`, `12d`, `8mo`, `2y`.
 * Returns an empty string when the time is unknown, so a missing mtime leaves a
 * blank cell instead of a made-up age. Clock skew (a future mtime) reads as `now`.
 */
export function formatAge(modifiedMs: number | undefined, now: number): string {
  if (modifiedMs === undefined) return "";
  const elapsed = Math.max(0, now - modifiedMs);
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  const days = Math.floor(elapsed / DAY_MS);
  if (days < 60) return `${days}d`;
  if (days < 730) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Full-sentence age for the detail line: `3 days ago`, `8 months ago`. */
export function describeAge(modifiedMs: number | undefined, now: number): string {
  if (modifiedMs === undefined) return "";
  const elapsed = Math.max(0, now - modifiedMs);
  if (elapsed < MINUTE_MS) return "just now";
  const unit = (count: number, singular: string) =>
    `${count} ${singular}${count === 1 ? "" : "s"} ago`;
  if (elapsed < HOUR_MS) return unit(Math.floor(elapsed / MINUTE_MS), "minute");
  if (elapsed < DAY_MS) return unit(Math.floor(elapsed / HOUR_MS), "hour");
  const days = Math.floor(elapsed / DAY_MS);
  if (days < 60) return unit(days, "day");
  if (days < 730) return unit(Math.floor(days / 30), "month");
  return unit(Math.floor(days / 365), "year");
}

export function isRecent(modifiedMs: number | undefined, now: number): boolean {
  return modifiedMs !== undefined && now - modifiedMs < RECENT_WINDOW_MS;
}

const BAR_STEPS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

/**
 * Proportional bar in eighth-blocks, `width` cells wide, padded to `width`.
 * Linear on purpose: a 39 KB row next to a 90 MB row should look empty, not
 * be inflated to a visible sliver.
 */
export function sizeBar(bytes: number, maxBytes: number, width: number): string {
  if (width <= 0) return "";
  if (bytes <= 0 || maxBytes <= 0) return " ".repeat(width);
  const eighths = Math.round(Math.min(1, bytes / maxBytes) * width * 8);
  const full = Math.floor(eighths / 8);
  const partial = BAR_STEPS[eighths % 8] ?? "";
  return `${"█".repeat(full)}${partial}`.padEnd(width);
}
