import { basename } from "node:path";
import {
  IDLE_WINDOW_MS,
  PROTOCOL_VERSION,
  type ScanPlan,
  type StatusSummary,
} from "@kitsunekode/sweep-protocol";

const DAY_MS = 86_400_000;
const TOP_KINDS = 8;
const TOP_PROJECTS = 10;

/**
 * A plan reduced to its answer. Only safe and caution items count as space to
 * free; dangerous and blocked ones are reported as `protectedCount` and never
 * added to a size. A project is idle only when its last activity is known and
 * at least `idleWindowMs` old.
 */
export function summarizeStatus(
  plan: ScanPlan,
  nowMs: number = Date.now(),
  idleWindowMs: number = IDLE_WINDOW_MS,
): StatusSummary {
  let safeBytes = 0;
  let cautionBytes = 0;
  let protectedCount = 0;
  const kinds = new Map<string, { bytes: number; count: number }>();
  const projects = new Map<
    string,
    { bytes: number; activeMs: number; kinds: Map<string, { bytes: number; count: number }> }
  >();

  for (const candidate of plan.candidates) {
    if (candidate.riskTier === "dangerous" || candidate.riskTier === "blocked") {
      protectedCount += 1;
      continue;
    }
    const bytes = candidate.estimatedBytes || 0;
    if (candidate.riskTier === "safe") safeBytes += bytes;
    else cautionBytes += bytes;

    const kind = kinds.get(candidate.kind) ?? { bytes: 0, count: 0 };
    kind.bytes += bytes;
    kind.count += 1;
    kinds.set(candidate.kind, kind);

    const { projectRoot, projectActiveMs } = candidate;
    if (projectRoot && typeof projectActiveMs === "number" && projectActiveMs > 0) {
      const project = projects.get(projectRoot) ?? {
        bytes: 0,
        activeMs: projectActiveMs,
        kinds: new Map(),
      };
      project.bytes += bytes;
      const inProject = project.kinds.get(candidate.kind) ?? { bytes: 0, count: 0 };
      inProject.bytes += bytes;
      inProject.count += 1;
      project.kinds.set(candidate.kind, inProject);
      projects.set(projectRoot, project);
    }
  }

  const idleEntries = [...projects.entries()].filter(
    ([, project]) => nowMs - project.activeMs >= idleWindowMs,
  );
  const idle = idleEntries
    .map(([path, project]) => ({
      name: basename(path.replace(/[\\/]+$/, "")) || path,
      path,
      bytes: project.bytes,
      idleDays: Math.floor((nowMs - project.activeMs) / DAY_MS),
    }))
    .sort((a, b) => b.bytes - a.bytes);
  // What the idle bytes are made of, so a bar drawn for the headline number
  // adds up to it (the all-kinds bar covers more than the idle projects).
  const idleKinds = new Map<string, { bytes: number; count: number }>();
  for (const [, project] of idleEntries) {
    for (const [kind, value] of project.kinds) {
      const total = idleKinds.get(kind) ?? { bytes: 0, count: 0 };
      total.bytes += value.bytes;
      total.count += value.count;
      idleKinds.set(kind, total);
    }
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    targetDir: plan.targetDir,
    createdAt: plan.createdAt,
    scannedDirs: plan.summary.scannedDirs,
    reclaimableBytes: safeBytes + cautionBytes,
    safeBytes,
    cautionBytes,
    protectedCount,
    idle: {
      days: Math.round(idleWindowMs / DAY_MS),
      projects: idle.length,
      bytes: idle.reduce((sum, project) => sum + project.bytes, 0),
      kinds: [...idleKinds.entries()]
        .map(([kind, value]) => ({ kind, ...value }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, TOP_KINDS),
    },
    kinds: [...kinds.entries()]
      .map(([kind, value]) => ({ kind, ...value }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, TOP_KINDS),
    projects: idle.slice(0, TOP_PROJECTS),
  };
}
