import { basename } from "node:path";
import {
  IDLE_WINDOW_MS,
  PROTOCOL_VERSION,
  type ScanPlan,
  type StatusKindSummary,
  type StatusProject,
  type StatusSummary,
  type WorktreeState,
} from "@kitsunekode/sweep-protocol";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 86_400_000;
/** Matches ProjectsView's FINISHED_QUIET_MS: clean merged worktree quiet for >= 24h. */
const FINISHED_WORKTREE_QUIET_MS = DAY_MS;
const TOP_KINDS = 8;
const TOP_PROJECTS = 10;

interface ProjectBucket {
  bytes: number;
  activeMs: number | undefined;
  kinds: Map<string, { bytes: number; count: number }>;
  worktreeOf?: string;
  worktreeState?: WorktreeState;
}

/** Exact human label for an idle threshold: `"30+ days"`, `"12+ hours"`, `"1+ day"`. */
export function formatIdleWindowLabel(idleWindowMs: number): string {
  const safeMs = Math.max(0, idleWindowMs);
  if (safeMs >= DAY_MS && safeMs % DAY_MS === 0) {
    const days = safeMs / DAY_MS;
    return `${days}+ ${days === 1 ? "day" : "days"}`;
  }
  if (safeMs >= HOUR_MS && safeMs % HOUR_MS === 0) {
    const hours = safeMs / HOUR_MS;
    return `${hours}+ ${hours === 1 ? "hour" : "hours"}`;
  }
  if (safeMs >= HOUR_MS) {
    const hours = Number((safeMs / HOUR_MS).toFixed(1));
    return `${hours}+ ${hours === 1 ? "hour" : "hours"}`;
  }
  const minutes = Math.max(1, Math.round(safeMs / MINUTE_MS));
  return `${minutes}+ ${minutes === 1 ? "minute" : "minutes"}`;
}

function collectKinds(entries: Array<[string, ProjectBucket]>): StatusKindSummary[] {
  const merged = new Map<string, { bytes: number; count: number }>();
  for (const [, project] of entries) {
    for (const [kind, value] of project.kinds) {
      const total = merged.get(kind) ?? { bytes: 0, count: 0 };
      total.bytes += value.bytes;
      total.count += value.count;
      merged.set(kind, total);
    }
  }
  return [...merged.entries()]
    .map(([kind, value]) => ({ kind, ...value }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, TOP_KINDS);
}

function toStatusProject(path: string, project: ProjectBucket, nowMs: number): StatusProject {
  const idleMs = project.activeMs === undefined ? 0 : Math.max(0, nowMs - project.activeMs);
  return {
    name: basename(path.replace(/[\\/]+$/, "")) || path,
    path,
    bytes: project.bytes,
    idleDays: Math.floor(idleMs / DAY_MS),
    idleMs,
    ...(project.worktreeOf !== undefined ? { worktreeOf: project.worktreeOf } : {}),
    ...(project.worktreeState !== undefined ? { worktreeState: project.worktreeState } : {}),
  };
}

/**
 * A plan reduced to its answer. Only safe and caution items count as space to
 * free; dangerous and blocked ones are reported as `protectedCount` /
 * `protectedBytes` and never added to a size. A project is idle only when its
 * last activity is proven and at least `idleWindowMs` old; clean merged
 * worktrees quiet for >= 24h are surfaced under `finishedWorktrees` (D5
 * parity with Projects view) and excluded from `idle` so bytes are never
 * double-counted.
 */
export function summarizeStatus(
  plan: ScanPlan,
  nowMs: number = Date.now(),
  idleWindowMs: number = IDLE_WINDOW_MS,
): StatusSummary {
  let safeBytes = 0;
  let cautionBytes = 0;
  let protectedCount = 0;
  let protectedBytes = 0;
  let partialByteCount = 0;
  let hasUniqueBytes = plan.summary.uniqueTotalBytes !== undefined;
  let reclaimableUniqueSum = 0;
  const kinds = new Map<string, { bytes: number; count: number }>();
  const projects = new Map<string, ProjectBucket>();

  for (const candidate of plan.candidates) {
    const bytes = candidate.estimatedBytes || 0;
    if (candidate.riskTier === "dangerous" || candidate.riskTier === "blocked") {
      protectedCount += 1;
      protectedBytes += bytes;
      continue;
    }
    if (candidate.uniqueBytes !== undefined) hasUniqueBytes = true;
    reclaimableUniqueSum += candidate.uniqueBytes ?? bytes;
    if (candidate.bytesKnown === false) partialByteCount += 1;
    if (candidate.riskTier === "safe") safeBytes += bytes;
    else cautionBytes += bytes;

    const kind = kinds.get(candidate.kind) ?? { bytes: 0, count: 0 };
    kind.bytes += bytes;
    kind.count += 1;
    kinds.set(candidate.kind, kind);

    const { projectRoot, projectActiveMs, worktreeOf, worktreeState } = candidate;
    if (projectRoot) {
      const project: ProjectBucket = projects.get(projectRoot) ?? {
        bytes: 0,
        activeMs: undefined,
        kinds: new Map(),
      };
      project.bytes += bytes;
      if (typeof projectActiveMs === "number" && projectActiveMs > 0) {
        project.activeMs =
          project.activeMs === undefined
            ? projectActiveMs
            : Math.max(project.activeMs, projectActiveMs);
      }
      if (worktreeOf !== undefined && project.worktreeOf === undefined) {
        project.worktreeOf = worktreeOf;
      }
      if (worktreeState === "upstream_gone") {
        // D5: upstream_gone always takes precedence over merged.
        project.worktreeState = "upstream_gone";
      } else if (worktreeState === "merged" && project.worktreeState === undefined) {
        project.worktreeState = "merged";
      }
      const inProject = project.kinds.get(candidate.kind) ?? { bytes: 0, count: 0 };
      inProject.bytes += bytes;
      inProject.count += 1;
      project.kinds.set(candidate.kind, inProject);
      projects.set(projectRoot, project);
    }
  }

  const allProjects = [...projects.entries()];
  const finishedEntries = allProjects.filter(
    ([, project]) =>
      project.worktreeState === "merged" &&
      project.activeMs !== undefined &&
      nowMs - project.activeMs >= FINISHED_WORKTREE_QUIET_MS,
  );
  const finishedPaths = new Set(finishedEntries.map(([path]) => path));
  const finishedItems = finishedEntries
    .map(([path, project]) => toStatusProject(path, project, nowMs))
    .sort((a, b) => b.bytes - a.bytes);

  const branchMissingEntries = allProjects.filter(
    ([, project]) => project.worktreeState === "upstream_gone",
  );

  const idleEntries = allProjects.filter(
    ([path, project]) =>
      !finishedPaths.has(path) &&
      project.activeMs !== undefined &&
      nowMs - project.activeMs >= idleWindowMs,
  );
  const idle = idleEntries
    .map(([path, project]) => toStatusProject(path, project, nowMs))
    .sort((a, b) => b.bytes - a.bytes);

  const skippedDirs = plan.summary.skippedDirs ?? 0;
  const bytesPartial = partialByteCount > 0;

  const reclaimableBytes = safeBytes + cautionBytes;
  const uniqueBytesPartial = plan.summary.uniqueBytesPartial === true;
  const uniqueReclaimableBytes = hasUniqueBytes
    ? protectedBytes === 0 && plan.summary.uniqueTotalBytes !== undefined
      ? Math.min(reclaimableBytes, Math.max(reclaimableUniqueSum, plan.summary.uniqueTotalBytes))
      : Math.min(reclaimableBytes, reclaimableUniqueSum)
    : undefined;

  return {
    protocolVersion: PROTOCOL_VERSION,
    targetDir: plan.targetDir,
    createdAt: plan.createdAt,
    scannedDirs: plan.summary.scannedDirs,
    skippedDirs,
    bytesPartial,
    partialByteCount,
    complete: skippedDirs === 0 && !bytesPartial,
    reclaimableBytes,
    ...(uniqueReclaimableBytes !== undefined ? { uniqueReclaimableBytes } : {}),
    ...(uniqueBytesPartial ? { uniqueBytesPartial: true } : {}),
    safeBytes,
    cautionBytes,
    protectedCount,
    protectedBytes,
    idle: {
      days: Math.round(idleWindowMs / DAY_MS),
      windowMs: idleWindowMs,
      windowLabel: formatIdleWindowLabel(idleWindowMs),
      projects: idle.length,
      bytes: idle.reduce((sum, project) => sum + project.bytes, 0),
      kinds: collectKinds(idleEntries),
    },
    finishedWorktrees: {
      projects: finishedItems.length,
      bytes: finishedItems.reduce((sum, project) => sum + project.bytes, 0),
      kinds: collectKinds(finishedEntries),
      items: finishedItems.slice(0, TOP_PROJECTS),
    },
    branchMissingWorktrees: {
      projects: branchMissingEntries.length,
      bytes: branchMissingEntries.reduce((sum, [, project]) => sum + project.bytes, 0),
    },
    kinds: [...kinds.entries()]
      .map(([kind, value]) => ({ kind, ...value }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, TOP_KINDS),
    projects: idle.slice(0, TOP_PROJECTS),
  };
}
