// Central type definitions for sweep.
// All other modules import from here — never define types inline in modules.

export interface SweepConfig {
  /** Patterns to match (directory names or *.ext globs). Merged across all config layers. */
  patterns: string[];
  /** Paths containing these strings are skipped entirely. Merged across all config layers. */
  ignore: string[];
  /** Abort if estimated total exceeds this. Bypass with --force-large. Default: 10 */
  maxSizeGB: number;
  /** Max recursion depth. -1 = unlimited. Default: -1 */
  depth: number;
}

export interface ScanEntry {
  /** Absolute path to the matched entry */
  path: string;
  /** Basename (the matched pattern name) */
  name: string;
  /** Size in bytes. Exact when scan was called with exact=true, estimated otherwise */
  estimatedBytes: number;
  /** True if this entry is a symlink — affects deletion method */
  isSymlink: boolean;
}

export interface ScanResult {
  entries: ScanEntry[];
  /** Sum of estimatedBytes across all entries */
  estimatedTotalBytes: number;
  /** How many directories were visited during the scan */
  scannedDirs: number;
  /** True when sizes were computed exactly (--dry-run), false for fast estimates */
  exact: boolean;
}

export interface CleanResult {
  deleted: ScanEntry[];
  /** Entries that failed to delete, with error message */
  failedPaths: Array<{ path: string; error: string }>;
  /** Sum of estimatedBytes for deleted entries */
  totalBytesFreed: number;
  durationMs: number;
}

/** Parsed CLI options from commander */
export interface CliOptions {
  dryRun: boolean;
  yes: boolean;
  forceLarge: boolean;
  /** Extra patterns passed via -p flag (merged with config) */
  pattern: string[];
  /** Extra ignore patterns passed via -i flag (merged with config) */
  ignore: string[];
  /** -1 means not set on CLI (use config/default) */
  depth: number;
  config?: string;
  color: boolean;
}
