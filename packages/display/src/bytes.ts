/** Compact duration for scan timing: 96ms, 1.2s, 2m 4s. */
export function formatScanElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms - minutes * 60_000) / 1000)}s`;
}

/** Format bytes into human-readable string with appropriate unit */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;
  const i = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
