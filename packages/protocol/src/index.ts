export const PROTOCOL_VERSION = "1" as const;

export type RiskTier = "safe" | "caution" | "dangerous" | "blocked";

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

export interface CleanResult {
  deleted: ScanEntry[];
  failedPaths: Array<{ path: string; error: string }>;
  totalBytesFreed: number;
  durationMs: number;
}

export interface CliOptions {
  dryRun: boolean;
  yes: boolean;
  forceLarge: boolean;
  pattern: string[];
  ignore: string[];
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
  failedPaths: Array<{ path: string; error: string }>;
}
