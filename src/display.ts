import pc from "picocolors";
import type { CleanResult, ScanResult } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format bytes into human-readable string with appropriate unit */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "~";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Pad a string to a fixed width (left-aligned) */
function padEnd(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"] as const;

export interface Spinner {
  update: (text: string) => void;
  stop: () => void;
}

/** Create a TTY spinner. In non-TTY environments, emits a single static line. */
export function createSpinner(initialText: string): Spinner {
  if (!process.stdout.isTTY) {
    process.stdout.write(`sweep: ${initialText}\n`);
    return {
      update: () => {},
      stop: () => {},
    };
  }

  let current = initialText;
  let frameIdx = 0;

  const id = setInterval(() => {
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length] ?? "⠋";
    process.stdout.write(`\r${pc.cyan(frame)} ${current}`);
    frameIdx++;
  }, 80);

  return {
    update: (text: string) => {
      current = text;
    },
    stop: () => {
      clearInterval(id);
      process.stdout.write("\r\x1b[K"); // clear line
    },
  };
}

// ─── Output sections ──────────────────────────────────────────────────────────

export function printBanner(): void {
  if (!process.stdout.isTTY) return;
  console.log(`\n ${pc.bold(pc.cyan("sweep"))} ${pc.dim("—")} ${pc.dim("artifact cleanup")}\n`);
}

export function printScanSummary(result: ScanResult, targetDir: string): void {
  if (process.stdout.isTTY) {
    console.log(
      pc.dim(`Scanned ${pc.bold(result.scannedDirs.toString())} dirs in `) + pc.bold(targetDir),
    );
    console.log();
  }

  if (result.entries.length === 0) {
    console.log(pc.green("✓") + " Nothing to clean.");
    return;
  }

  // Find max name length for alignment
  const maxNameLen = Math.max(...result.entries.map((e) => e.name.length), 12);

  const sizePrefix = result.exact ? "" : "~";

  for (const entry of result.entries) {
    const size = formatBytes(entry.estimatedBytes);
    const symlinkBadge = entry.isSymlink ? pc.dim(" [symlink]") : "";

    if (process.stdout.isTTY) {
      console.log(
        `  ${pc.red("✗")} ${pc.bold(padEnd(entry.name, maxNameLen))}` +
          `  ${pc.dim(entry.path)}` +
          `  ${pc.yellow(`${sizePrefix}${size}`)}` +
          symlinkBadge,
      );
    } else {
      console.log(`sweep: found ${entry.name} (${entry.path}) ${sizePrefix}${size}${symlinkBadge}`);
    }
  }

  console.log();

  const totalLabel = result.exact ? "total" : "estimated";
  if (process.stdout.isTTY) {
    console.log(
      `  ${pc.bold(result.entries.length.toString())} items, ` +
        `${pc.yellow(`${sizePrefix}${formatBytes(result.estimatedTotalBytes)}`)} ${totalLabel}`,
    );
    console.log();
  }
}

export function printDryRunNotice(): void {
  console.log(pc.dim(pc.italic("  Dry run — no files deleted.")));
  console.log();
}

export function printCleanResult(result: CleanResult): void {
  const duration =
    result.durationMs < 1000
      ? `${result.durationMs}ms`
      : `${(result.durationMs / 1000).toFixed(1)}s`;

  if (process.stdout.isTTY) {
    console.log(
      `${pc.green("✓")} Cleaned ${pc.bold(result.deleted.length.toString())} items, ` +
        `${pc.bold(pc.green(formatBytes(result.totalBytesFreed)))} freed ` +
        pc.dim(`(${duration})`),
    );
  } else {
    console.log(`sweep: done — ${formatBytes(result.totalBytesFreed)} freed in ${duration}`);
  }

  if (result.failedPaths.length > 0) {
    console.log();
    console.log(pc.yellow(`⚠ ${result.failedPaths.length} item(s) failed to delete:`));
    for (const { path, error } of result.failedPaths) {
      console.log(`  ${pc.dim(path)}: ${pc.red(error)}`);
    }
  }
}

export function printAborted(): void {
  console.log(pc.dim("Aborted."));
}

export function printError(message: string): void {
  console.error(`\n  ${pc.red("✗")} ${message}\n`);
}
