import APPLY_REPORT_SCHEMA_JSON from "../schemas/apply-report.schema.json";
import PROTOCOL_SHARED_SCHEMA_JSON from "../schemas/shared.schema.json";
import SCAN_EVENT_SCHEMA_JSON from "../schemas/scan-event.schema.json";
import SCAN_PLAN_SCHEMA_JSON from "../schemas/scan-plan.schema.json";

export const PROTOCOL_VERSION = "1" as const;

/** Logical scan bounds, shared by discovery and metadata sizing. */
export interface ScanLimits {
  maxCandidates: number;
  maxDirectories: number;
  maxQueuedDirs: number;
  maxIdentities: number;
  maxPathBytes: number;
  maxRetainedBytes: number;
  /** Combined discovery charges and live sizing reservations. Not RSS. */
  maxCombinedBytes: number;
}

export const DEFAULT_SCAN_LIMITS: Readonly<ScanLimits> = Object.freeze({
  maxCandidates: 100_000,
  maxDirectories: 250_000,
  maxQueuedDirs: 32_768,
  maxIdentities: 500_000,
  maxPathBytes: 64 * 1024 * 1024,
  maxRetainedBytes: 128 * 1024 * 1024,
  maxCombinedBytes: 256 * 1024 * 1024,
});

export type ResourceProfile = "balanced" | "low-memory";
export const SCAN_RESOURCE_PROFILES: Readonly<Record<ResourceProfile, Readonly<ScanLimits>>> =
  Object.freeze({
    balanced: DEFAULT_SCAN_LIMITS,
    "low-memory": Object.freeze({
      maxCandidates: 5_000,
      maxDirectories: 50_000,
      maxQueuedDirs: 2_048,
      maxIdentities: 65_536,
      maxPathBytes: 8 * 1024 * 1024,
      maxRetainedBytes: 8 * 1024 * 1024,
      maxCombinedBytes: 16 * 1024 * 1024,
    }),
  });

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
  /** Optional deletion-byte ceiling in GiB. null means no byte cap; zero is a zero cap. */
  maxSizeGB: number | null;
  depth: number;
}

export { candidateKindFromName, KNOWN_ARTIFACT_NAMES } from "./candidate.js";
export { sanitizeTerminalText, sanitizeMultilineTerminalText } from "./text.js";

/** Exact decimal identifiers; JSON numbers would lose large inode precision. */
export interface FilesystemIdentity {
  platform: "unix" | "windows";
  device: string;
  inode: string;
}

export interface ScanEntry {
  /** Captured at discovery. Missing identities cannot authorize an apply. */
  identity?: FilesystemIdentity | undefined;
  path: string;
  name: string;
  estimatedBytes: number;
  /**
   * `false` when sizing hit unreadable inodes — `estimatedBytes` is then a
   * partial lower bound, not the subtree's real size. Absent on plans from
   * producers that predate the field (treated as complete). Found events in a
   * stream report `false` until their update lands.
   */
  bytesKnown?: boolean;
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
  targetIdentity?: FilesystemIdentity | undefined;
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

export interface TrashMove {
  path: string;
  destination: string;
}

export interface CleanResult {
  trashMoves?: TrashMove[];
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
  /** Per-run deletion ceiling in GiB; none explicitly disables a configured cap. */
  maxSizeGb?: number | "none";
  config?: string;
  color: boolean;
  engine: EngineBackend;
  /** Dev flag: fresh engine probe + page-cache drop attempt before scanning. */
  cold?: boolean;
  resourceProfile?: "balanced" | "low-memory";
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
  "candidates_found",
  "candidates_updated",
  "scan_progress",
  "warning",
  "scan_completed",
] as const;

export type ScanEventType = (typeof SCAN_EVENT_TYPES)[number];

export interface ScanStartedEvent {
  type: "scan_started";
  targetDir: string;
  targetIdentity?: FilesystemIdentity | undefined;
}

export interface CandidateFoundEvent {
  type: "candidate_found";
  candidate: ScanCandidate;
}

export interface CandidateUpdatedEvent {
  type: "candidate_updated";
  candidate: ScanCandidate;
}

/**
 * Batched forms - the Rust emitter accumulates candidates and flushes on a
 * ~16ms cadence so a busy scan costs a few dozen wire lines instead of one
 * per candidate. Ordering per candidate is preserved: found always precedes
 * its own update on the wire.
 */
export interface CandidatesFoundEvent {
  type: "candidates_found";
  candidates: ScanCandidate[];
}

export interface CandidatesUpdatedEvent {
  type: "candidates_updated";
  candidates: ScanCandidate[];
}

export interface ScanProgressEvent {
  type: "scan_progress";
  scannedDirs: number;
  found: number;
  /** Unreadable / deduped directories - absent on older producers. */
  skippedDirs?: number;
  /**
   * Candidates whose size has resolved - powers honest sizing progress while
   * discovery is still running. Absent on older producers.
   */
  sizedCount?: number;
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
  | CandidatesFoundEvent
  | CandidatesUpdatedEvent
  | ScanProgressEvent
  | WarningEvent
  | ScanCompletedEvent;

export interface ScanPlan {
  protocolVersion: typeof PROTOCOL_VERSION;
  targetDir: string;
  /** Captured before traversal, never refreshed when loading a saved plan. */
  targetIdentity?: FilesystemIdentity | undefined;
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

export interface ApplyOutcome {
  candidateId: string;
  status: "deleted" | "failed" | "covered" | "unattempted";
  coveredBy?: string;
}

/** Live feedback counts completed removals, not files inside an active directory. */
export interface ApplyProgress {
  stage: "preparing" | "applying" | "stopping";
  selectedCount: number;
  deletedCount: number;
  estimatedBytesFreed: number;
  elapsedMs: number;
  activePath?: string;
  preparationPhase?: "validating" | "sizing";
  preparedCount?: number;
  preparingCount?: number;
  /** Successful unlink/rmdir operations inside the active artifact, when the
   * backend supports them. Includes directories/symlinks; not a byte estimate. */
  removedEntries?: number;
}

export interface ApplyReport {
  trashMoves?: TrashMove[];
  protocolVersion: typeof PROTOCOL_VERSION;
  targetDir: string;
  selectedCandidateIds: string[];
  deletedCount: number;
  failedCount: number;
  totalBytesFreed: number;
  failedPaths: PathFailure[];
  /** Actual operations and covered/unattempted selections. Absent on legacy engines. */
  outcomes?: ApplyOutcome[];
  interrupted?: boolean;
}
