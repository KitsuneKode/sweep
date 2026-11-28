import { formatBytes } from "@kitsunekode/sweep-display";
import type { FooterHint } from "./presentation.js";
import type { SweepUiState } from "./state.js";
import type { NoticeTone } from "./theme.js";

export type UiAction =
  | { type: "replace"; state: SweepUiState }
  | { type: "mutate"; fn: (state: SweepUiState) => SweepUiState };

export function uiReducer(state: SweepUiState, action: UiAction): SweepUiState {
  if (action.type === "replace") return action.state;
  return action.fn(state);
}

export interface Notice {
  text: string;
  tone: NoticeTone;
}

export type ModalKind =
  | "help"
  | "confirm"
  | "inspect"
  | "scanError"
  | "applying"
  | "menu"
  | "jump"
  | "filter"
  | "folderInfo"
  | "configSave"
  | "patternInfo";

/** Compact duration for scan timing chips/notices: 96ms, 1.2s, 2m 4s. */
export function formatScanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms - minutes * 60_000) / 1000)}s`;
}

function formatRatio(ratio: number): string {
  return ratio >= 10 ? `${Math.round(ratio)}×` : `${ratio.toFixed(1)}×`;
}

/**
 * Scan-timing fragment for the completion notice: `rust 96ms` alone, or
 * `rust 96ms vs js 214ms (2.2× faster)` once both engines have timed a run
 * on this tree.
 */
export function engineTimingLabel(
  engine: "js" | "rust",
  durations: Partial<Record<"js" | "rust", number>>,
): string {
  const current = durations[engine];
  if (current === undefined) return engine;
  const otherEngine = engine === "rust" ? "js" : "rust";
  const other = durations[otherEngine];
  if (other === undefined) return `${engine} ${formatScanMs(current)}`;
  const ratio = other > 0 ? current / other : 1;
  const verdict =
    ratio < 0.95
      ? `${formatRatio(1 / ratio)} faster`
      : ratio > 1.05
        ? `${formatRatio(ratio)} slower`
        : "about equal";
  return `${engine} ${formatScanMs(current)} vs ${otherEngine} ${formatScanMs(other)} (${verdict})`;
}

/** `~/x` for the calm header. */
export function displayTargetPath(path: string): string {
  const home = process.env.HOME;
  if (home && path === home) return "~";
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

/** The calm view's one line of hints: only what applies right now. */
export function calmHintItems(context: {
  scanning: boolean;
  idleBytes: number;
  queued: boolean;
  width: number;
}): FooterHint[] {
  const parts: FooterHint[] = [
    { key: "space", label: "queue", press: { name: "space" } },
    // With a queue, reviewing it is the next step and clearing it the way
    // back: neither falls off the end. Without one, `a` queues everything
    // removable at once (never dangerous items).
    ...(context.queued
      ? [
          { key: "c", label: "review", press: { name: "c" }, next: true },
          { key: "u", label: "clear", press: { name: "u" } },
        ]
      : [{ key: "a", label: "queue all", press: { name: "a" } }]),
    { key: "x", label: "remove", press: { name: "x" } },
    { key: "enter", label: "open", press: { name: "return" } },
    { key: "b", label: "full view", press: { name: "b" } },
    { key: "/", label: "search", press: { name: "/" } },
  ];
  if (!context.scanning && context.idleBytes > 0)
    parts.push({
      key: "i",
      label: `idle ${formatBytes(context.idleBytes)}`,
      press: { name: "i" },
    });
  // `? keys` is the way out for anyone lost: its room is held first, and it
  // always ends the line, however narrow the terminal. Budget against the
  // ProjectsView usable width with exact filled keycap widths (` key ` + ` label`)
  // and 2-cell separators so hints never clip or crowd out `b full view`.
  const help: FooterHint = { key: "?", label: "keys", press: { name: "?" } };
  const itemWidth = (part: FooterHint) => part.key.length + 3 + part.label.length;
  const lineWidth = Math.min(116, Math.max(20, context.width - 6));
  let budget = lineWidth - itemWidth(help);
  const kept: FooterHint[] = [];
  for (const part of parts) {
    const needed = itemWidth(part) + 2; // includes the 2-cell gap before the next hint / help
    if (needed > budget) continue;
    kept.push(part);
    budget -= needed;
  }
  return [...kept, help];
}
