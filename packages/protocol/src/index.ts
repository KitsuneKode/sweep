import APPLY_REPORT_SCHEMA_JSON from "../schemas/apply-report.schema.json";
import PROTOCOL_SHARED_SCHEMA_JSON from "../schemas/shared.schema.json";
import SCAN_EVENT_SCHEMA_JSON from "../schemas/scan-event.schema.json";
import SCAN_PLAN_SCHEMA_JSON from "../schemas/scan-plan.schema.json";

export const PROTOCOL_VERSION = "1" as const;

export type RiskTier = "safe" | "caution" | "dangerous" | "blocked";
export type SelectionMode = "default" | "safe" | "all" | "none";
export type FailureReasonCode =
  | "missing"
  | "changed_symlink_state"
  | "changed_entry_type"
  | "outside_target"
  | "protected_path"
  | "permission_denied"
  | "busy"
  | "filesystem_error";

export type CandidateKind =
  | "node_modules"
  | "dist"
  | "build"
  | "out"
  | ".next"
  | ".nuxt"
  | ".svelte-kit"
  | ".turbo"
  | ".vite"
  | ".parcel-cache"
  | "target"
  | "coverage"
  | ".nyc_output"
  | "tsbuildinfo"
  | "custom";

export interface SweepConfig {
  patterns: string[];
  /** Patterns removed from the merged default + custom set (project/global/CLI). */
  disabledPatterns?: string[];
  ignore: string[];
  maxSizeGB: number;
  depth: number;
}

export { candidateKindFromName, KNOWN_ARTIFACT_NAMES } from "./candidate.js";
export { sanitizeTerminalText, sanitizeMultilineTerminalText } from "./text.js";

export interface ScanEntry {
  path: string;
  name: string;
  estimatedBytes: number;
  /**
   * Last-modified time of the artifact itself (epoch ms), from a single
   * `lstat` on the matched path. It is the directory's own mtime, so it moves
   * when direct children are added or removed (an install, a rebuild) and
   * answers "when did this last change". Absent when the stat failed or the
   * plan came from an engine that predates the field.
   */
  modifiedMs?: number;
  isSymlink: boolean;
  entryType: "file" | "directory" | "symlink";
}

export interface ScanResult {
  entries: ScanEntry[];
  estimatedTotalBytes: number;
  scannedDirs: number;
  /** Directories the walker could not read or had already visited via another path. */
  skippedDirs: number;
  exact: boolean;
}

export interface PathFailure {
  path: string;
  code: FailureReasonCode;
  error: string;
}

export interface CleanResult {
  deleted: ScanEntry[];
  failedPaths: PathFailure[];
  totalBytesFreed: number;
  durationMs: number;
}

export type EngineBackend = "auto" | "js" | "rust";

export interface CliOptions {
  dryRun: boolean;
  yes: boolean;
  forceLarge: boolean;
  pattern: string[];
  disabledPattern: string[];
  ignore: string[];
  includeDangerous: boolean;
  select: SelectionMode;
  /** Absent unless the user passed --depth - config layers stay reachable. */
  depth?: number;
  config?: string;
  color: boolean;
  engine: EngineBackend;
  quiet?: boolean;
  verbose?: boolean;
  json?: boolean;
  /** Move candidates to .sweep-trash-<ts>/ under the target instead of deleting. */
  trash?: boolean;
}

export interface ScanCandidate extends ScanEntry {
  id: string;
  kind: CandidateKind;
  riskTier: RiskTier;
  reasons: string[];
  selectedByDefault: boolean;
}

export interface SelectionPolicy {
  mode: SelectionMode;
  includeDangerous: boolean;
}

export const DEFAULT_SELECTION_POLICY: SelectionPolicy = {
  mode: "default",
  includeDangerous: false,
};

export const FAILURE_REASON_CODES = [
  "missing",
  "changed_symlink_state",
  "changed_entry_type",
  "outside_target",
  "protected_path",
  "permission_denied",
  "busy",
  "filesystem_error",
] as const;

export const SCAN_PLAN_SCHEMA = SCAN_PLAN_SCHEMA_JSON;
export const APPLY_REPORT_SCHEMA = APPLY_REPORT_SCHEMA_JSON;
export const PROTOCOL_SHARED_SCHEMA = PROTOCOL_SHARED_SCHEMA_JSON;
export const SCAN_EVENT_SCHEMA = SCAN_EVENT_SCHEMA_JSON;

export const SCAN_EVENT_TYPES = [
  "scan_started",
  "candidate_found",
  "candidate_updated",
  "scan_progress",
  "warning",
  "scan_completed",
] as const;

export type ScanEventType = (typeof SCAN_EVENT_TYPES)[number];

export interface ScanStartedEvent {
  type: "scan_started";
  targetDir: string;
}

export interface CandidateFoundEvent {
  type: "candidate_found";
  candidate: ScanCandidate;
}

export interface CandidateUpdatedEvent {
  type: "candidate_updated";
  candidate: ScanCandidate;
}

export interface ScanProgressEvent {
  type: "scan_progress";
  scannedDirs: number;
  found: number;
  /** Unreadable / deduped directories - absent on older producers. */
  skippedDirs?: number;
  /**
   * Directory being walked, relative to the target - powers "scanning x/"
   * lines in progress surfaces. Absent on older producers.
   */
  currentDir?: string;
}

export interface WarningEvent {
  type: "warning";
  message: string;
  candidateId?: string;
}

export interface ScanCompletedEvent {
  type: "scan_completed";
  summary: {
    candidateCount: number;
    estimatedTotalBytes: number;
    scannedDirs: number;
    /** Unreadable / deduped directories - absent on older producers. */
    skippedDirs?: number;
    /** True when byte estimates are exact - absent on older producers. */
    exact?: boolean;
    /**
     * Wall-clock scan time in milliseconds - absent on older producers and on
     * non-streaming paths that don't time the walk.
     */
    elapsedMs?: number;
  };
}

export type ScanEvent =
  | ScanStartedEvent
  | CandidateFoundEvent
  | CandidateUpdatedEvent
  | ScanProgressEvent
  | WarningEvent
  | ScanCompletedEvent;

export interface ScanPlan {
  protocolVersion: typeof PROTOCOL_VERSION;
  targetDir: string;
  selectionPolicy: SelectionPolicy;
  candidates: ScanCandidate[];
  summary: {
    candidateCount: number;
    estimatedTotalBytes: number;
    scannedDirs: number;
    /** Unreadable / deduped directories - absent on plans written before v1.x. */
    skippedDirs?: number;
    exact: boolean;
    selectedCount: number;
    riskCounts: Record<RiskTier, number>;
  };
  selectedCandidateIds: string[];
  createdAt: string;
}

export interface ApplyReport {
  protocolVersion: typeof PROTOCOL_VERSION;
  targetDir: string;
  selectedCandidateIds: string[];
  deletedCount: number;
  failedCount: number;
  totalBytesFreed: number;
  failedPaths: PathFailure[];
}
