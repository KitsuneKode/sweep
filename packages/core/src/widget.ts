import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import {
  IDLE_WINDOW_MS,
  PROTOCOL_VERSION,
  REBUILD_COSTS,
  WIDGET_CACHE_SCHEMA,
  WIDGET_CACHE_VERSION,
  WIDGET_EVENT_SCHEMA,
  WIDGET_MAX_CACHE_BYTES,
  WIDGET_MAX_CACHE_ENTRIES,
  WIDGET_RECEIPT_VERSION,
  WIDGET_SCHEMA_VERSION,
  WIDGET_SNAPSHOT_SCHEMA,
  WIDGET_STALE_MS,
  sanitizeTerminalText,
  type RebuildCost,
  type ScanPlan,
  type WidgetCacheEnvelope,
  type WidgetCostBucket,
  type WidgetDiskInfo,
  type WidgetError,
  type WidgetErrorCode,
  type WidgetEvent,
  type WidgetProjectSummary,
  type WidgetProjectsSummary,
  type WidgetReceipt,
  type WidgetSnapshot,
  type WidgetSource,
  type WidgetSuggestion,
  type WorktreeState,
} from "@kitsunekode/sweep-protocol";
import { checkPosixTrust } from "./config.js";
import { REBUILD_COST_META, rebuildFor } from "./rebuild.js";

const DAY_MS = 86_400_000;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RECEIPT_BYTES = 16 * 1024;
const TOP_KINDS = 8;
const TOP_PROJECTS = 10;
const WIDGET_CACHE_FILE = "widget-v1.json";
const WIDGET_RECEIPT_FILE = "last-receipt.json";

let widgetAjv: Ajv2020 | undefined;
let validateWidgetSnapshotFn: ValidateFunction | undefined;
let validateWidgetEventFn: ValidateFunction | undefined;
let validateWidgetCacheFn: ValidateFunction | undefined;

function getWidgetAjv(): Ajv2020 {
  if (!widgetAjv) {
    widgetAjv = new Ajv2020({ allErrors: false, strict: false, validateFormats: false });
    widgetAjv.addSchema(WIDGET_SNAPSHOT_SCHEMA);
  }
  return widgetAjv;
}

export function isValidWidgetSnapshot(value: unknown): value is WidgetSnapshot {
  if (!validateWidgetSnapshotFn) {
    validateWidgetSnapshotFn = getWidgetAjv().compile(WIDGET_SNAPSHOT_SCHEMA);
  }
  return Boolean(validateWidgetSnapshotFn(value));
}

export function isValidWidgetEvent(value: unknown): value is WidgetEvent {
  if (!validateWidgetEventFn) {
    validateWidgetEventFn = getWidgetAjv().compile(WIDGET_EVENT_SCHEMA);
  }
  return Boolean(validateWidgetEventFn(value));
}

export function isValidWidgetCacheEnvelope(value: unknown): value is WidgetCacheEnvelope {
  if (!validateWidgetCacheFn) {
    validateWidgetCacheFn = getWidgetAjv().compile(WIDGET_CACHE_SCHEMA);
  }
  return Boolean(validateWidgetCacheFn(value));
}

function formatBinaryBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;
  const i = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function clampString(value: string, maxLength: number): string {
  const clean = sanitizeTerminalText(value);
  return clean.length > maxLength ? clean.slice(0, maxLength) : clean;
}

function buildCostBuckets(
  totals: ReadonlyMap<RebuildCost, { bytes: number; count: number }>,
): WidgetCostBucket[] {
  const buckets: WidgetCostBucket[] = [];
  for (const cost of REBUILD_COSTS) {
    const entry = totals.get(cost);
    if (!entry || entry.bytes <= 0) continue;
    const meta = REBUILD_COST_META[cost];
    buckets.push({
      cost,
      label: meta.label,
      bytes: entry.bytes,
      count: entry.count,
      hint: meta.hint,
    });
  }
  return buckets;
}

/**
 * Reduce a complete ScanPlan to the bounded Projects widget summary.
 *
 * Trust invariant: only `safe` and `caution` candidates contribute to
 * `reclaimableBytes`, `byCost`, `topKinds`, `idle`, `worktrees`, and
 * `topProjects`. `dangerous` and `blocked` candidates are reported separately
 * in `guardedBytes` and `protectedCount` and never inflate reclaimable totals.
 */
export function summarizeWidgetProjects(
  plan: ScanPlan,
  options: { nowMs?: number; idleWindowMs?: number } = {},
): WidgetProjectsSummary {
  const nowMs = options.nowMs ?? Date.now();
  const idleWindowMs = options.idleWindowMs ?? IDLE_WINDOW_MS;

  let safeBytes = 0;
  let cautionBytes = 0;
  let guardedBytes = 0;
  let protectedCount = 0;

  const byCostTotals = new Map<RebuildCost, { bytes: number; count: number }>();
  const kindsTotals = new Map<string, { bytes: number; count: number }>();

  interface ProjectAcc {
    bytes: number;
    activeMs: number | undefined;
    worktreeOf: string | undefined;
    worktreeState: WorktreeState | undefined;
    byCost: Map<RebuildCost, { bytes: number; count: number }>;
  }
  const projects = new Map<string, ProjectAcc>();

  for (const candidate of plan.candidates) {
    const bytes = Math.max(0, Math.trunc(candidate.estimatedBytes || 0));
    if (candidate.riskTier === "dangerous" || candidate.riskTier === "blocked") {
      protectedCount += 1;
      guardedBytes += bytes;
      continue;
    }

    if (candidate.riskTier === "safe") safeBytes += bytes;
    else cautionBytes += bytes;

    const ownerRoot = candidate.projectRoot ?? dirname(candidate.path);
    const cost = rebuildFor(candidate.kind, ownerRoot, candidate.name).cost;

    const costAcc = byCostTotals.get(cost) ?? { bytes: 0, count: 0 };
    costAcc.bytes += bytes;
    costAcc.count += 1;
    byCostTotals.set(cost, costAcc);

    const kindAcc = kindsTotals.get(candidate.kind) ?? { bytes: 0, count: 0 };
    kindAcc.bytes += bytes;
    kindAcc.count += 1;
    kindsTotals.set(candidate.kind, kindAcc);

    if (candidate.projectRoot) {
      let project = projects.get(candidate.projectRoot);
      if (!project) {
        project = {
          bytes: 0,
          activeMs: undefined,
          worktreeOf: undefined,
          worktreeState: undefined,
          byCost: new Map(),
        };
        projects.set(candidate.projectRoot, project);
      }
      project.bytes += bytes;
      if (typeof candidate.projectActiveMs === "number" && candidate.projectActiveMs > 0) {
        project.activeMs =
          project.activeMs === undefined
            ? candidate.projectActiveMs
            : Math.max(project.activeMs, candidate.projectActiveMs);
      }
      if (candidate.worktreeOf && !project.worktreeOf) {
        project.worktreeOf = candidate.worktreeOf;
      }
      if (candidate.worktreeState && !project.worktreeState) {
        project.worktreeState = candidate.worktreeState;
      }
      const projCost = project.byCost.get(cost) ?? { bytes: 0, count: 0 };
      projCost.bytes += bytes;
      projCost.count += 1;
      project.byCost.set(cost, projCost);
    }
  }

  let idleProjects = 0;
  let idleBytes = 0;
  let finishedWorktrees = 0;
  let finishedWorktreeBytes = 0;
  const worktreeCostTotals = new Map<RebuildCost, { bytes: number; count: number }>();

  const finishedList: WidgetProjectSummary[] = [];
  const idleList: WidgetProjectSummary[] = [];
  const otherList: WidgetProjectSummary[] = [];

  for (const [projectPath, project] of projects) {
    const isIdle =
      project.activeMs !== undefined &&
      project.activeMs > 0 &&
      nowMs - project.activeMs >= idleWindowMs;
    const isFinishedWorktree =
      project.worktreeOf !== undefined && project.worktreeState === "merged";

    if (isIdle) {
      idleProjects += 1;
      idleBytes += project.bytes;
    }
    if (isFinishedWorktree) {
      finishedWorktrees += 1;
      finishedWorktreeBytes += project.bytes;
      for (const [cost, bucket] of project.byCost) {
        const acc = worktreeCostTotals.get(cost) ?? { bytes: 0, count: 0 };
        acc.bytes += bucket.bytes;
        acc.count += bucket.count;
        worktreeCostTotals.set(cost, acc);
      }
    }

    const cleanPath = clampString(projectPath, 4096);
    const rawName = basename(projectPath.replace(/[\\/]+$/, "")) || projectPath;
    const entry: WidgetProjectSummary = {
      name: clampString(rawName, 256),
      path: cleanPath,
      bytes: project.bytes,
    };
    if (project.worktreeOf) {
      const rawRepo = basename(project.worktreeOf.replace(/[\\/]+$/, "")) || project.worktreeOf;
      entry.repo = clampString(rawRepo, 256);
    }
    if (project.activeMs !== undefined && project.activeMs > 0) {
      entry.idleDays = Math.max(0, Math.floor((nowMs - project.activeMs) / DAY_MS));
    }
    if (project.worktreeState) {
      entry.worktreeState = project.worktreeState;
    }

    if (isFinishedWorktree) {
      finishedList.push(entry);
    } else if (isIdle) {
      idleList.push(entry);
    } else {
      otherList.push(entry);
    }
  }

  const byBytesDesc = (a: WidgetProjectSummary, b: WidgetProjectSummary) =>
    b.bytes - a.bytes || a.path.localeCompare(b.path);
  finishedList.sort(byBytesDesc);
  idleList.sort(byBytesDesc);
  otherList.sort(byBytesDesc);

  const topProjects = [...finishedList, ...idleList, ...otherList].slice(0, TOP_PROJECTS);

  const topKinds = [...kindsTotals.entries()]
    .map(([kind, value]) => ({
      kind: clampString(kind, 128),
      bytes: value.bytes,
      count: value.count,
    }))
    .sort((a, b) => b.bytes - a.bytes || a.kind.localeCompare(b.kind))
    .slice(0, TOP_KINDS);

  return {
    reclaimableBytes: safeBytes + cautionBytes,
    safeBytes,
    cautionBytes,
    guardedBytes,
    protectedCount,
    projectCount: projects.size,
    idle: {
      days: Math.max(0, Math.round(idleWindowMs / DAY_MS)),
      projects: idleProjects,
      bytes: idleBytes,
    },
    worktrees: {
      finished: finishedWorktrees,
      bytes: finishedWorktreeBytes,
      byCost: buildCostBuckets(worktreeCostTotals),
    },
    byCost: buildCostBuckets(byCostTotals),
    topKinds,
    topProjects,
  };
}

export function buildWidgetSuggestion(summary: WidgetProjectsSummary): WidgetSuggestion | null {
  if (summary.reclaimableBytes <= 0) return null;

  if (summary.worktrees.finished > 0 && summary.worktrees.bytes > 0) {
    const count = summary.worktrees.finished;
    const noun = count === 1 ? "worktree" : "worktrees";
    const verb = count === 1 ? "holds" : "hold";
    const size = formatBinaryBytes(summary.worktrees.bytes);
    return {
      kind: "worktrees",
      full: `${count} finished ${noun} ${verb} ${size}. Merged branches can be reviewed first.`,
      short: `${count} finished ${noun} ${verb} ${size}.`,
      action: {
        intent: "review_projects",
        label: `Review ${count} ${noun}`,
        view: "projects",
        focus: "worktrees",
      },
    };
  }

  if (summary.idle.projects > 0 && summary.idle.bytes > 0) {
    const count = summary.idle.projects;
    const noun = count === 1 ? "project" : "projects";
    const verb = count === 1 ? "holds" : "hold";
    const size = formatBinaryBytes(summary.idle.bytes);
    return {
      kind: "idle",
      full: `${count} idle ${noun} ${verb} ${size}. Untouched for ${summary.idle.days}+ days.`,
      short: `${count} idle ${noun} ${verb} ${size}.`,
      action: {
        intent: "review_projects",
        label: "Review idle projects",
        view: "projects",
        focus: "idle",
      },
    };
  }

  const size = formatBinaryBytes(summary.reclaimableBytes);
  return {
    kind: "reclaimable",
    full: `${size} of reclaimable build output found. Nothing is removed until you review it in Sweep.`,
    short: `${size} reclaimable.`,
    action: {
      intent: "review_projects",
      label: "Review in Sweep",
      view: "projects",
    },
  };
}

function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, oct: string) =>
    String.fromCharCode(Number.parseInt(oct, 8)),
  );
}

function resolveMountPoint(targetDir: string): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const raw = readFileSync("/proc/self/mountinfo", "utf8");
    let best: string | undefined;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const fields = line.split(" ");
      const mountRaw = fields[4];
      if (!mountRaw) continue;
      const mount = unescapeMountField(mountRaw);
      const matches =
        mount === "/" || targetDir === mount || targetDir.startsWith(`${mount}${sep}`);
      if (matches && (best === undefined || mount.length > best.length)) {
        best = mount;
      }
    }
    return best ? clampString(best, 4096) : undefined;
  } catch {
    return undefined;
  }
}

export function readWidgetDiskInfo(targetDir: string): WidgetDiskInfo | null {
  try {
    const stats = statfsSync(targetDir);
    const totalBytes = Math.max(0, Math.round(Number(stats.blocks) * Number(stats.bsize)));
    const freeBytes = Math.max(0, Math.round(Number(stats.bavail) * Number(stats.bsize)));
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const mountPoint = resolveMountPoint(targetDir);
    return {
      ...(mountPoint ? { mountPoint } : {}),
      totalBytes,
      usedBytes,
      freeBytes,
    };
  } catch {
    return null;
  }
}

export function buildWidgetSnapshot(
  plan: ScanPlan,
  options: {
    nowMs?: number;
    elapsedMs?: number;
    idleWindowMs?: number;
    disk?: WidgetDiskInfo | null;
    receipt?: WidgetReceipt | null;
    source?: WidgetSource;
    staleAfterMs?: number;
  } = {},
): WidgetSnapshot {
  const nowMs = options.nowMs ?? Date.now();
  const source = options.source ?? "live";
  const staleAfterMs = options.staleAfterMs ?? WIDGET_STALE_MS;
  const parsedCreatedAt = Date.parse(plan.createdAt);
  const generatedAt = Number.isFinite(parsedCreatedAt)
    ? new Date(parsedCreatedAt).toISOString()
    : new Date(nowMs).toISOString();
  const ageMs =
    source === "cache" && Number.isFinite(parsedCreatedAt)
      ? Math.max(0, Math.trunc(nowMs - parsedCreatedAt))
      : 0;
  const stale = source === "cache" && ageMs >= staleAfterMs;
  const skippedDirs = Math.max(0, Math.trunc(plan.summary.skippedDirs ?? 0));
  const hasUnknownSize = plan.candidates.some((c) => c.bytesKnown === false);
  const partial = skippedDirs > 0 || hasUnknownSize;
  const summary = summarizeWidgetProjects(plan, {
    nowMs,
    ...(options.idleWindowMs !== undefined ? { idleWindowMs: options.idleWindowMs } : {}),
  });
  const state = stale ? "stale" : summary.reclaimableBytes === 0 ? "empty" : "ok";

  return {
    widgetSchemaVersion: WIDGET_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    readOnly: true,
    view: "projects",
    supportedViews: ["projects"],
    targetDir: clampString(plan.targetDir, 4096),
    generatedAt,
    ageMs,
    elapsedMs: Math.max(0, Math.round(options.elapsedMs ?? 0)),
    source,
    state,
    stale,
    partial,
    skippedDirs,
    disk: options.disk !== undefined ? options.disk : readWidgetDiskInfo(plan.targetDir),
    projectsSummary: summary,
    suggestion: buildWidgetSuggestion(summary),
    receipt: options.receipt ?? null,
    space: null,
    error: null,
  };
}

export function buildWidgetErrorSnapshot(
  targetDir: string,
  error: WidgetError,
  options: {
    nowMs?: number;
    elapsedMs?: number;
    disk?: WidgetDiskInfo | null;
    receipt?: WidgetReceipt | null;
  } = {},
): WidgetSnapshot {
  const nowMs = options.nowMs ?? Date.now();
  return {
    widgetSchemaVersion: WIDGET_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    readOnly: true,
    view: "projects",
    supportedViews: ["projects"],
    targetDir: clampString(targetDir, 4096),
    generatedAt: new Date(nowMs).toISOString(),
    ageMs: 0,
    elapsedMs: Math.max(0, Math.round(options.elapsedMs ?? 0)),
    source: "live",
    state: "error",
    stale: false,
    partial: false,
    skippedDirs: 0,
    disk: options.disk ?? null,
    projectsSummary: null,
    suggestion: null,
    receipt: options.receipt ?? null,
    space: null,
    error,
  };
}

export function buildEmptyCacheSnapshot(
  targetDir: string,
  options: {
    nowMs?: number;
    disk?: WidgetDiskInfo | null;
    receipt?: WidgetReceipt | null;
  } = {},
): WidgetSnapshot {
  const nowMs = options.nowMs ?? Date.now();
  return {
    widgetSchemaVersion: WIDGET_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    readOnly: true,
    view: "projects",
    supportedViews: ["projects"],
    targetDir: clampString(targetDir, 4096),
    generatedAt: new Date(nowMs).toISOString(),
    ageMs: 0,
    elapsedMs: 0,
    source: "cache",
    state: "stale",
    stale: true,
    partial: false,
    skippedDirs: 0,
    disk: options.disk !== undefined ? options.disk : readWidgetDiskInfo(targetDir),
    projectsSummary: null,
    suggestion: null,
    receipt: options.receipt ?? null,
    space: null,
    error: null,
  };
}

/**
 * Map a WidgetErrorCode to a plain user-facing message that never contains
 * helper filenames, stack traces, raw OS paths, or exit codes.
 */
export function widgetErrorForCode(code: WidgetErrorCode): WidgetError {
  switch (code) {
    case "engine_missing":
      return {
        code,
        message: "Native scan engine unavailable. Scans can still run with the fallback scanner.",
        retryable: true,
        fallbackAvailable: true,
      };
    case "permission_denied":
      return {
        code,
        message: "Your account does not have read permission on this folder.",
        retryable: false,
      };
    case "target_missing":
      return {
        code,
        message: "The configured scan folder does not exist.",
        retryable: false,
      };
    case "timeout":
      return {
        code,
        message: "The scan timed out before sizing finished.",
        retryable: true,
      };
    case "not_installed":
      return {
        code,
        message: "Sweep is not installed on this system.",
        retryable: false,
      };
    case "schema_mismatch":
      return {
        code,
        message: "Update Sweep or the desktop widget so both speak the same schema version.",
        retryable: false,
      };
    case "scan_failed":
    default:
      return {
        code: "scan_failed",
        message: "Could not finish scanning this folder.",
        retryable: true,
      };
  }
}

/** Parse a non-negative widget duration like `45s`, `30m`, `2h`, `1d`. */
export function parseWidgetDuration(text: string): number {
  const match = /^(\d+)([smhd])$/i.exec(text.trim());
  if (!match) {
    throw new Error(`expected a duration like 45s, 30m, 2h, or 1d; got "${text}"`);
  }
  const value = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: DAY_MS,
  };
  const ms = value * multipliers[unit]!;
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new Error(`duration "${text}" is out of range`);
  }
  return ms;
}

// ─── Private L4 Cache & Receipt I/O ───────────────────────────────────────────

export function widgetCacheDir(): string {
  if (process.env.SWEEP_CACHE_DIR) return process.env.SWEEP_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, "sweep");
  // Keep isolated runs (which set SWEEP_CONFIG_DIR without XDG_CACHE_HOME) off ~/.cache.
  if (process.env.SWEEP_CONFIG_DIR) return join(process.env.SWEEP_CONFIG_DIR, "cache");
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "sweep");
  }
  return join(homedir(), ".cache", "sweep");
}

export function widgetCachePath(): string {
  return join(widgetCacheDir(), WIDGET_CACHE_FILE);
}

export function widgetStateDir(): string {
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, "sweep");
  if (process.env.SWEEP_CONFIG_DIR) return join(process.env.SWEEP_CONFIG_DIR, "state");
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "sweep", "state");
  }
  return join(homedir(), ".local", "state", "sweep");
}

export function widgetReceiptPath(): string {
  return join(widgetStateDir(), WIDGET_RECEIPT_FILE);
}

function readTrustedSmallFile(filePath: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(filePath, { bigint: true });
    if (!before.isFile()) return null;
    if (before.size > BigInt(maxBytes)) return null;
    fd = openSync(
      filePath,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = fstatSync(fd);
    const identity = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || identity.dev !== before.dev || identity.ino !== before.ino) return null;
    if (checkPosixTrust(stat) !== null) return null;
    if (stat.size > maxBytes) return null;
    const buf = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const n = readSync(fd, buf, offset, stat.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return buf.subarray(0, offset).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
}

export function readWidgetCacheEnvelope(
  cachePath: string = widgetCachePath(),
): WidgetCacheEnvelope {
  const raw = readTrustedSmallFile(cachePath, WIDGET_MAX_CACHE_BYTES);
  if (!raw) return { cacheVersion: WIDGET_CACHE_VERSION, entries: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidWidgetCacheEnvelope(parsed)) {
      return { cacheVersion: WIDGET_CACHE_VERSION, entries: {} };
    }
    return parsed;
  } catch {
    return { cacheVersion: WIDGET_CACHE_VERSION, entries: {} };
  }
}

export function readWidgetCacheEntry(
  targetDir: string,
  options: {
    nowMs?: number;
    staleAfterMs?: number;
    cachePath?: string;
    receipt?: WidgetReceipt | null;
  } = {},
): WidgetSnapshot | null {
  const envelope = readWidgetCacheEnvelope(options.cachePath);
  const entry = envelope.entries[targetDir];
  if (!entry || !isValidWidgetSnapshot(entry)) return null;

  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? WIDGET_STALE_MS;
  const generatedMs = Date.parse(entry.generatedAt);
  const ageMs = Number.isFinite(generatedMs) ? Math.max(0, Math.trunc(nowMs - generatedMs)) : 0;
  const stale = ageMs >= staleAfterMs;
  const state =
    entry.error !== null
      ? "error"
      : stale
        ? "stale"
        : entry.projectsSummary !== null && entry.projectsSummary.reclaimableBytes === 0
          ? "empty"
          : "ok";

  return {
    ...entry,
    source: "cache",
    ageMs,
    stale,
    state,
    ...(options.receipt !== undefined ? { receipt: options.receipt } : {}),
  };
}

function ensurePrivateDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory()) return false;
    if (checkPosixTrust(stat) !== null) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically persist a WidgetSnapshot into the bounded L4 cache envelope
 * (`0600`, temp file + fsync + rename, max 8 entries, `< 64 KiB` total).
 */
export function writeWidgetCacheEntry(
  snapshot: WidgetSnapshot,
  options: { cachePath?: string } = {},
): boolean {
  if (!isValidWidgetSnapshot(snapshot)) return false;
  if (snapshot.error !== null || snapshot.projectsSummary === null) return false;

  const cachePath = options.cachePath ?? widgetCachePath();
  const dir = dirname(cachePath);
  if (!ensurePrivateDir(dir)) return false;

  // Refuse to write over a symlink at the destination cache path.
  try {
    const destStat = lstatSync(cachePath);
    if (!destStat.isFile() || checkPosixTrust(destStat) !== null) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }

  const envelope = readWidgetCacheEnvelope(cachePath);
  const storedEntry: WidgetSnapshot = {
    ...snapshot,
    source: "cache",
    ageMs: 0,
    stale: false,
    receipt: null,
  };
  const nextEntries: Record<string, WidgetSnapshot> = {
    ...envelope.entries,
    [snapshot.targetDir]: storedEntry,
  };

  // Sort keys newest-first so we can bound both entry count (<= 8) and bytes (< 64 KiB).
  const orderedKeys = Object.keys(nextEntries).sort((a, b) => {
    if (a === snapshot.targetDir) return -1;
    if (b === snapshot.targetDir) return 1;
    const ta = Date.parse(nextEntries[a]!.generatedAt) || 0;
    const tb = Date.parse(nextEntries[b]!.generatedAt) || 0;
    return tb - ta;
  });

  const keptKeys = orderedKeys.slice(0, WIDGET_MAX_CACHE_ENTRIES);
  let serialized = "";
  while (keptKeys.length > 0) {
    const boundedEntries: Record<string, WidgetSnapshot> = {};
    for (const key of keptKeys) {
      boundedEntries[key] = nextEntries[key]!;
    }
    const candidateEnvelope: WidgetCacheEnvelope = {
      cacheVersion: WIDGET_CACHE_VERSION,
      entries: boundedEntries,
    };
    const text = `${JSON.stringify(candidateEnvelope)}\n`;
    if (Buffer.byteLength(text, "utf8") < WIDGET_MAX_CACHE_BYTES) {
      serialized = text;
      break;
    }
    keptKeys.pop();
  }
  if (!serialized) return false;

  const tmpPath = join(dir, `.widget-v1.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    const buf = Buffer.from(serialized, "utf8");
    let written = 0;
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, cachePath);
    return true;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close error
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    return false;
  }
}

export function readRecentWidgetReceipt(
  targetDir: string,
  options: { nowMs?: number; receiptPath?: string } = {},
): WidgetReceipt | null {
  const raw = readTrustedSmallFile(options.receiptPath ?? widgetReceiptPath(), MAX_RECEIPT_BYTES);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const r = parsed as Partial<WidgetReceipt>;
    if (
      r.receiptVersion !== WIDGET_RECEIPT_VERSION ||
      typeof r.id !== "string" ||
      r.id.length === 0 ||
      r.id.length > 128 ||
      typeof r.completedAt !== "string" ||
      r.targetDir !== targetDir ||
      (r.mode !== "delete" && r.mode !== "trash") ||
      typeof r.stopped !== "boolean"
    ) {
      return null;
    }
    const nums = [r.deletedCount, r.failedCount, r.unattemptedCount, r.totalBytesFreed];
    if (!nums.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) {
      return null;
    }
    if (
      r.freeBytesAfter !== null &&
      !(
        typeof r.freeBytesAfter === "number" &&
        Number.isSafeInteger(r.freeBytesAfter) &&
        r.freeBytesAfter >= 0
      )
    ) {
      return null;
    }
    const completedMs = Date.parse(r.completedAt);
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isFinite(completedMs) || nowMs - completedMs > RECEIPT_TTL_MS) {
      return null;
    }
    if (r.failureSummary !== null) {
      const f = r.failureSummary;
      if (
        typeof f !== "object" ||
        f === null ||
        ![f.busy, f.permissionDenied, f.other].every(
          (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
        )
      ) {
        return null;
      }
    }
    return r as WidgetReceipt;
  } catch {
    return null;
  }
}
