import pc from "picocolors";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes, formatScanElapsed } from "./bytes.js";

/** Format a deletion progress line for terminal output. */
export function formatDeletionProgress(
  current: number,
  total: number,
  currentPath?: string,
): string {
  const prefix = `[${current}/${total}]`;
  if (!currentPath) return prefix;
  // Paths come off disk - escape control characters before terminal output.
  return `${prefix} ${sanitizeTerminalText(currentPath)}`;
}

export interface DeletionStatus {
  current: number;
  total: number;
  path?: string;
  verb?: string;
  itemBytes?: number;
  runningBytes?: number;
  elapsedMs?: number;
  /** Visible columns. The path is the part that shrinks. */
  columns?: number;
}

function truncateMiddle(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  if (max <= 1) return "…";
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.max(0, max - 1 - head);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

interface BuiltDeletionStatus {
  plain: string;
  verb: string;
  count: string;
  path: string;
  item: string;
  running: string;
  elapsed: string;
}

function buildDeletionStatus(status: DeletionStatus): BuiltDeletionStatus {
  const verb = status.verb ?? "deleting";
  const count = `[${status.current}/${status.total}]`;
  const item = (status.itemBytes ?? 0) > 0 ? formatBytes(status.itemBytes ?? 0) : "";
  const running =
    (status.runningBytes ?? 0) > 0 && status.runningBytes !== status.itemBytes
      ? `~${formatBytes(status.runningBytes ?? 0)} ${verb === "moving" ? "moved" : "removed"}`
      : "";
  const elapsed = (status.elapsedMs ?? 0) >= 1000 ? formatScanElapsed(status.elapsedMs ?? 0) : "";
  const tailBits = [item, running, elapsed].filter((part) => part.length > 0);
  const tail = tailBits.length > 0 ? `  ${tailBits.join("  ")}` : "";
  const path = status.path ? sanitizeTerminalText(status.path) : "";
  const columns = status.columns ?? Number.POSITIVE_INFINITY;

  if (path.length === 0) {
    const line = `${verb} ${count}${tail}`;
    const plain = line.length <= columns ? line : line.slice(0, Math.max(0, columns));
    return { plain, verb, count, path: "", item, running, elapsed };
  }

  const head = `${verb} ${count} `;
  const room = columns - head.length - tail.length;
  if (room <= 1) {
    const line = `${verb} ${count}${tail}`;
    const plain = line.length <= columns ? line : line.slice(0, Math.max(0, columns));
    return { plain, verb, count, path: "", item, running, elapsed };
  }
  const shown = truncateMiddle(path, room);
  return {
    plain: `${head}${shown}${tail}`,
    verb,
    count,
    path: shown,
    item,
    running,
    elapsed,
  };
}

/**
 * One status line for a delete or trash move. The count is how many have
 * finished; the path is the one in flight. Long paths lose the middle so the
 * tally and the elapsed time stay on the same row.
 */
export function formatDeletionStatus(status: DeletionStatus): string {
  return buildDeletionStatus(status).plain;
}

/**
 * Print a deletion progress update.
 * @param itemBytes  size of the item just deleted (shown as the per-item size)
 * @param runningBytes  optional cumulative removed-size estimate (trailing tally)
 */
export function printDeletionProgress(
  current: number,
  total: number,
  currentPath?: string,
  itemBytes = 0,
  runningBytes = 0,
  options: { verb?: string; elapsedMs?: number; columns?: number } = {},
): void {
  const columns = options.columns ?? process.stdout.columns ?? 80;
  const built = buildDeletionStatus({
    current,
    total,
    ...(currentPath ? { path: currentPath } : {}),
    ...(options.verb ? { verb: options.verb } : {}),
    itemBytes,
    runningBytes,
    ...(options.elapsedMs !== undefined ? { elapsedMs: options.elapsedMs } : {}),
    columns,
  });
  const colored =
    pc.cyan(`${built.verb} ${built.count}`) +
    (built.path ? ` ${built.path}` : "") +
    (built.item ? `  ${pc.yellow(built.item)}` : "") +
    (built.running ? `  ${pc.green(built.running)}` : "") +
    (built.elapsed ? `  ${pc.dim(built.elapsed)}` : "");

  if (process.stdout.isTTY) {
    // Erase the previous path. A shorter update must not leave the tail of a
    // longer one, and a path wider than the terminal must not wrap.
    process.stdout.write(`\r${colored}\x1b[K`);
    progressDrawn = true;
    return;
  }

  // Bun console.log bypasses stdout stream errors; apply needs observable EPIPE.
  process.stdout.write(`sweep: ${built.plain}\n`);
}

/**
 * Whether this process ever drew a transient progress line. The erase write
 * must only happen when a line exists - under `--json` on a real TTY, an
 * unconditional `\r\x1b[K` would corrupt the machine-readable payload.
 */
let progressDrawn = false;

/** Clear the active deletion progress line in TTY mode. */
export function clearDeletionProgress(): void {
  if (process.stdout.isTTY && progressDrawn) {
    process.stdout.write("\r\x1b[K");
    progressDrawn = false;
  }
}
