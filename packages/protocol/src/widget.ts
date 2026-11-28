import type { WorktreeState } from "./index.js";

export const REBUILD_COSTS = ["cache", "install", "build", "custom"] as const;
export type RebuildCost = (typeof REBUILD_COSTS)[number];

export const WIDGET_SCHEMA_VERSION = 1 as const;
export const WIDGET_CACHE_VERSION = 1 as const;
export const WIDGET_RECEIPT_VERSION = 1 as const;

export const WIDGET_VIEWS = ["projects"] as const;
export type WidgetView = (typeof WIDGET_VIEWS)[number];

export type WidgetSource = "live" | "cache";
export type WidgetState = "ok" | "empty" | "stale" | "error";

export const WIDGET_ERROR_CODES = [
  "not_installed",
  "engine_missing",
  "permission_denied",
  "target_missing",
  "target_refused",
  "config_invalid",
  "timeout",
  "scan_failed",
  "schema_mismatch",
] as const;
export type WidgetErrorCode = (typeof WIDGET_ERROR_CODES)[number];

export const WIDGET_ACTION_INTENTS = [
  "review_projects",
  "review_space_developer",
  "review_space_caches",
  "review_space_trash",
  "inspect_receipt",
] as const;
export type WidgetActionIntent = (typeof WIDGET_ACTION_INTENTS)[number];

export const WIDGET_EVENT_TYPES = [
  "widget_started",
  "widget_progress",
  "widget_snapshot",
  "widget_error",
] as const;
export type WidgetEventType = (typeof WIDGET_EVENT_TYPES)[number];

/** Cache entries older than 60 minutes are marked stale for desktop widgets. */
export const WIDGET_STALE_MS = 60 * 60 * 1000;
/** Max cached scan roots retained in the bounded L4 envelope. */
export const WIDGET_MAX_CACHE_ENTRIES = 8;
/** Hard upper bound (bytes) for the serialized L4 cache envelope on disk. */
export const WIDGET_MAX_CACHE_BYTES = 64 * 1024;
/** Progress frames are coalesced to <= 12 Hz (>= 80 ms interval). */
export const WIDGET_PROGRESS_MIN_INTERVAL_MS = 80;

export interface WidgetDiskInfo {
  mountPoint?: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

export interface WidgetCostBucket {
  cost: RebuildCost;
  label: string;
  bytes: number;
  count: number;
  hint: string;
}

export interface WidgetKindSummary {
  kind: string;
  bytes: number;
  count: number;
}

export interface WidgetProjectSummary {
  name: string;
  repo?: string;
  path: string;
  bytes: number;
  idleDays?: number;
  worktreeState?: WorktreeState;
}

export interface WidgetProjectsSummary {
  /** Safe + caution bytes only. Guarded (dangerous/blocked) bytes are never included. */
  reclaimableBytes: number;
  safeBytes: number;
  cautionBytes: number;
  /** Dangerous + blocked bytes, reported separately so they never inflate reclaimableBytes. */
  guardedBytes: number;
  /** Count of dangerous + blocked items. */
  protectedCount: number;
  /** Count of distinct projects holding reclaimable artifacts. */
  projectCount: number;
  idle: {
    days: number;
    projects: number;
    bytes: number;
  };
  worktrees: {
    finished: number;
    bytes: number;
    byCost: WidgetCostBucket[];
  };
  byCost: WidgetCostBucket[];
  topKinds: WidgetKindSummary[];
  topProjects: WidgetProjectSummary[];
}

export interface WidgetAction {
  intent: WidgetActionIntent;
  label: string;
  view: WidgetView;
  focus?: "worktrees" | "idle";
}

export interface WidgetSuggestion {
  kind: "worktrees" | "idle" | "reclaimable";
  full: string;
  short: string;
  action: WidgetAction;
}

export interface WidgetReceiptFailureSummary {
  busy: number;
  permissionDenied: number;
  other: number;
}

export interface WidgetReceipt {
  receiptVersion: typeof WIDGET_RECEIPT_VERSION;
  id: string;
  completedAt: string;
  targetDir: string;
  mode: "delete" | "trash";
  deletedCount: number;
  failedCount: number;
  unattemptedCount: number;
  stopped: boolean;
  totalBytesFreed: number;
  freeBytesAfter: number | null;
  failureSummary: WidgetReceiptFailureSummary | null;
}

export interface WidgetError {
  code: WidgetErrorCode;
  message: string;
  retryable: boolean;
  fallbackAvailable?: boolean;
}

export interface WidgetSnapshot {
  widgetSchemaVersion: typeof WIDGET_SCHEMA_VERSION;
  protocolVersion: "1";
  readOnly: true;
  view: WidgetView;
  supportedViews: WidgetView[];
  targetDir: string;
  generatedAt: string;
  ageMs: number;
  elapsedMs: number;
  source: WidgetSource;
  state: WidgetState;
  stale: boolean;
  partial: boolean;
  skippedDirs: number;
  disk: WidgetDiskInfo | null;
  projectsSummary: WidgetProjectsSummary | null;
  suggestion: WidgetSuggestion | null;
  receipt: WidgetReceipt | null;
  space: null;
  error: WidgetError | null;
}

export interface WidgetStartedEvent {
  type: "widget_started";
  widgetSchemaVersion: typeof WIDGET_SCHEMA_VERSION;
  view: WidgetView;
  targetDir: string;
  startedAt: string;
}

export interface WidgetProgressEvent {
  type: "widget_progress";
  widgetSchemaVersion: typeof WIDGET_SCHEMA_VERSION;
  view: WidgetView;
  scannedDirs: number;
  found: number;
  sizedCount: number;
  estimatedBytes: number;
  currentDir?: string;
  byCost: { cost: RebuildCost; bytes: number }[];
}

export interface WidgetSnapshotEvent {
  type: "widget_snapshot";
  widgetSchemaVersion: typeof WIDGET_SCHEMA_VERSION;
  snapshot: WidgetSnapshot;
}

export interface WidgetErrorEvent {
  type: "widget_error";
  widgetSchemaVersion: typeof WIDGET_SCHEMA_VERSION;
  error: WidgetError;
}

export type WidgetEvent =
  | WidgetStartedEvent
  | WidgetProgressEvent
  | WidgetSnapshotEvent
  | WidgetErrorEvent;

export interface WidgetCacheEnvelope {
  cacheVersion: typeof WIDGET_CACHE_VERSION;
  entries: Record<string, WidgetSnapshot>;
}
