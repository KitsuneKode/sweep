import pc from "picocolors";
import { formatBytes } from "./index.js";

/** Format a deletion progress line for terminal output. */
export function formatDeletionProgress(
  current: number,
  total: number,
  currentPath?: string,
): string {
  const prefix = `[${current}/${total}]`;
  if (!currentPath) return prefix;
  return `${prefix} ${currentPath}`;
}

/** Print a deletion progress update, clearing the previous line in TTY mode. */
export function printDeletionProgress(
  current: number,
  total: number,
  currentPath?: string,
  freedBytes = 0,
): void {
  const line = formatDeletionProgress(current, total, currentPath);
  const suffix = freedBytes > 0 ? `  ${pc.green(formatBytes(freedBytes))} freed` : "";

  if (process.stdout.isTTY) {
    process.stdout.write(`\r${pc.cyan("…")} ${line}${suffix}`);
    return;
  }

  console.log(`sweep: deleting ${line}${suffix}`);
}

/** Clear the active deletion progress line in TTY mode. */
export function clearDeletionProgress(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\r\x1b[K");
  }
}
