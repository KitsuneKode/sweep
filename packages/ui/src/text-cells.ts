/** Terminal-cell layout for the Bun/OpenTUI UI; never split a grapheme cluster. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ascii = /^[\x20-\x7e]*$/;

export function cellWidth(value: string): number {
  return ascii.test(value) ? value.length : Bun.stringWidth(value);
}

function takeCells(value: string, budget: number, fromEnd = false): string {
  if (budget <= 0) return "";
  if (ascii.test(value)) return fromEnd ? value.slice(-budget) : value.slice(0, budget);
  const graphemes = Array.from(segmenter.segment(value), ({ segment }) => segment);
  if (fromEnd) graphemes.reverse();
  const taken: string[] = [];
  let used = 0;
  for (const grapheme of graphemes) {
    const width = cellWidth(grapheme);
    if (used + width > budget) break;
    taken.push(grapheme);
    used += width;
  }
  if (fromEnd) taken.reverse();
  return taken.join("");
}

export function clipCells(value: string, width: number, middle = false): string {
  if (width <= 0) return "";
  if (cellWidth(value) <= width) return value;
  if (width === 1) return "…";
  if (!middle) return `${takeCells(value, width - 1)}…`;
  const head = Math.ceil((width - 1) / 2);
  return `${takeCells(value, head)}…${takeCells(value, width - 1 - head, true)}`;
}

/** Keep the end of a value, where a path is most specific: "…/kitsunesnipe/.worktrees". */
export function clipStart(value: string, width: number): string {
  if (width <= 0) return "";
  if (cellWidth(value) <= width) return value;
  if (width === 1) return "…";
  return `…${takeCells(value, width - 1, true)}`;
}

export function padCells(value: string, width: number, align: "left" | "right" = "left"): string {
  const clipped = clipCells(value, width);
  const padding = " ".repeat(Math.max(0, width - cellWidth(clipped)));
  return align === "right" ? padding + clipped : clipped + padding;
}

/**
 * Clip prose at a word or phrase boundary whenever possible. Terminal chrome
 * must never silently slice a number or a word in half; when the text is one
 * unbreakable token (a path), fall back to ordinary cell clipping.
 */
export function clipWords(value: string, width: number): string {
  if (width <= 0) return "";
  if (cellWidth(value) <= width) return value;
  if (width === 1) return "…";
  const clipped = clipCells(value, width);
  const body = clipped.slice(0, -1);
  const lastSpace = body.lastIndexOf(" ");
  const lastSeparator = body.lastIndexOf("·");
  const cut = Math.max(lastSpace, lastSeparator);
  if (cut >= Math.max(4, Math.floor(width * 0.45))) {
    return `${body.slice(0, cut).trimEnd()}…`;
  }
  return clipped;
}
