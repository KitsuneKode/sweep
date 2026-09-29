import pc from "picocolors";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { formatBytes } from "./index.js";

/** Format a deletion progress line for terminal output. */
export function formatDeletionProgress(
  current: number,
  total: number,
  currentPath?: string,
): string {
  const prefix = `[${current}/${total}]`;
  if (!currentPath) return prefix;
  // Paths come off disk — escape control characters before terminal output.
  return `${prefix} ${sanitizeTerminalText(currentPath)}`;
}

/**
 * Print a deletion progress update.
 * @param itemBytes  size of the item just deleted (shown as the per-item size)
 * @param runningBytes  optional cumulative freed total (trailing running tally)
 */
export function printDeletionProgress(
  current: number,
  total: number,
  currentPath?: string,
  itemBytes = 0,
  runningBytes = 0,
  options: { verb?: string } = {},
): void {
  const line = formatDeletionProgress(current, total, currentPath);
  const sizeTag = itemBytes > 0 ? `  ${pc.yellow(formatBytes(itemBytes))}` : "";
  const runningTag =
    runningBytes > 0 && runningBytes !== itemBytes
      ? `  ${pc.green(`${formatBytes(runningBytes)} freed`)}`
      : "";
  const suffix = `${sizeTag}${runningTag}`;

  if (process.stdout.isTTY) {
    process.stdout.write(`\r${pc.cyan("…")} ${line}${suffix}`);
    return;
  }

  console.log(`sweep: ${options.verb ?? "deleting"} ${line}${suffix}`);
}

/** Clear the active deletion progress line in TTY mode. */
export function clearDeletionProgress(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\r\x1b[K");
  }
}
