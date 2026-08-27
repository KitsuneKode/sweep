/** Rows of context kept between the cursor and the viewport edge. */
export const SCROLL_MARGIN = 1;

/**
 * Viewport top after moving the cursor to `cursor`.
 *
 * "Nearest" scrolling, as cmdk does it: the viewport only moves when the cursor
 * would otherwise leave it, and then only far enough to bring it back with one
 * row of context. Recentering on every keystroke is what makes a list lurch.
 */
export function nextScrollTop(current: number, viewportHeight: number, cursor: number): number {
  const viewport = Math.max(1, viewportHeight);
  const margin = viewport > 2 * SCROLL_MARGIN + 1 ? SCROLL_MARGIN : 0;

  if (cursor - margin < current) return Math.max(0, cursor - margin);
  if (cursor + margin >= current + viewport) return cursor + margin - viewport + 1;
  return current;
}
