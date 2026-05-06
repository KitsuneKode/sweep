export const PROTOCOL_VERSION = "1" as const;

export type RiskTier = "safe" | "caution" | "dangerous" | "blocked";
export type SelectionMode = "default" | "safe" | "all" | "none";
export type FailureReasonCode =
  | "missing"
  | "changed_symlink_state"
  | "changed_entry_type"
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
  ignore: string[];
  maxSizeGB: number;
  depth: number;
}

export interface ScanEntry {
  path: string;
  name: string;
  estimatedBytes: number;
  isSymlink: boolean;
  entryType: "file" | "directory" | "symlink";
}

export interface ScanResult {
  entries: ScanEntry[];
  estimatedTotalBytes: number;
  scannedDirs: number;
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

export interface CliOptions {
  dryRun: boolean;
  yes: boolean;
  forceLarge: boolean;
  pattern: string[];
  ignore: string[];
  includeDangerous: boolean;
  select: SelectionMode;
  depth: number;
  config?: string;
  color: boolean;
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
  "permission_denied",
  "busy",
  "filesystem_error",
] as const;

export const SCAN_EVENT_TYPES = [
  "scan_started",
  "candidate_found",
  "candidate_updated",
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
  };
}

export type ScanEvent =
  | ScanStartedEvent
  | CandidateFoundEvent
  | CandidateUpdatedEvent
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
