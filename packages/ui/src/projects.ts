import { basename, dirname } from "node:path";
import {
  IDLE_WINDOW_DAYS,
  IDLE_WINDOW_MS,
  type ScanCandidate,
  type WorktreeState,
} from "@kitsunekode/sweep-protocol";
import { lastActiveMs } from "./age.js";
import { formatBytes } from "@kitsunekode/sweep-display";

/**
 * The projects view: one row per project, sorted into what nobody is using
 * and what someone is. It answers the question sweep is opened with - what
 * can I clean? - before any artifact row is read. Artifacts stay one Enter
 * away.
 */

export const IDLE_SECTION_MS = IDLE_WINDOW_MS;

export type ProjectSection = "finished" | "idle" | "recent" | "unknown";

/**
 * A finished worktree touched within this window stays where its activity
 * puts it: a branch merged an hour ago may still have someone in it.
 */
export const FINISHED_QUIET_MS = 86_400_000;

export const SECTION_TITLE: Record<ProjectSection, string> = {
  finished: "Finished worktrees",
  idle: `Idle ${IDLE_WINDOW_DAYS}+ days`,
  recent: "Worked on recently",
  unknown: "No activity found",
};

export interface Project {
  key: string;
  /** The folder's own name, and the path above it when two names collide. */
  name: string;
  parent: string;
  section: ProjectSection;
  activeMs: number | undefined;
  bytes: number;
  /**
   * Bytes that a project-level queue would take: safe and caution only. This
   * is the one number the view calls reclaimable, everywhere it is shown.
   */
  queueableBytes: number;
  /** Dangerous and blocked bytes: found, never counted as space to free. */
  guardedBytes: number;
  partial: boolean;
  artifacts: ScanCandidate[];
  /** Ids a project-level space queues: never dangerous or blocked. */
  queueable: string[];
  selected: number;
  kinds: string[];
  /** Items that need a look before removal; shown on the row, not only inside. */
  caution: number;
  dangerous: number;
  /** The repository a linked worktree belongs to. */
  worktreeOf?: string;
  worktreeState?: WorktreeState;
}

export type ProjectRow =
  | {
      kind: "section";
      section: ProjectSection;
      /** Reclaimable (safe + caution) bytes of the members. */
      bytes: number;
      guardedBytes: number;
      count: number;
    }
  | { kind: "project"; project: Project }
  | { kind: "artifact"; project: Project; candidate: ScanCandidate }
  | { kind: "more"; section: ProjectSection; count: number; bytes: number }
  | { kind: "moreArtifacts"; project: Project; count: number; bytes: number }
  | { kind: "spacer" };

/** Projects shown per section before the rest folds into one "+ N more" row. */
export const SECTION_PREVIEW = 8;
/** Artifacts an opened project lists before the small rest folds away. */
export const ARTIFACT_PREVIEW = 6;

const WORKTREE_STATE_LABEL: Record<WorktreeState, string> = {
  merged: "merged",
  upstream_gone: "branch missing",
};

/** Full worktree state sentence shown in the details margin. */
export const WORKTREE_STATE_DETAIL: Record<WorktreeState, string> = {
  merged: "Merged into default branch · clean",
  upstream_gone: "Tracking branch missing · check git",
};

/**
 * Where a project sits. A linked worktree names its repository and branch
 * state ("kitsunesnipe · merged"), not the `.worktrees` folder it lives in.
 */
function projectWhere(
  key: string,
  targetDir: string,
  worktreeOf: string | undefined,
  state: WorktreeState | undefined,
): string {
  if (worktreeOf === undefined) return relativeParent(key, targetDir);
  const repo = basename(worktreeOf) || worktreeOf;
  return `${repo} · ${state ? WORKTREE_STATE_LABEL[state] : "worktree"}`;
}

/** The folder a project sits in, relative to the scan target: "agency/.worktrees". */
function relativeParent(key: string, targetDir: string): string {
  const parent = dirname(key);
  if (!targetDir || parent === key || parent === targetDir) return "";
  if (parent.startsWith(`${targetDir}/`)) return parent.slice(targetDir.length + 1);
  const home = process.env.HOME;
  if (home && parent.startsWith(`${home}/`)) return `~${parent.slice(home.length)}`;
  return parent;
}

/** Before the plan carries a project root (while streaming), the parent folder stands in. */
export function projectKey(candidate: ScanCandidate): string {
  return candidate.projectRoot ?? dirname(candidate.path);
}

export function buildProjects(
  candidates: readonly ScanCandidate[],
  selectedIds: ReadonlySet<string>,
  targetDir = "",
  now = Date.now(),
): Project[] {
  const byKey = new Map<string, ScanCandidate[]>();
  for (const candidate of candidates) {
    const key = projectKey(candidate);
    const list = byKey.get(key);
    if (list) list.push(candidate);
    else byKey.set(key, [candidate]);
  }

  const projects: Project[] = [];
  for (const [key, artifacts] of byKey) {
    artifacts.sort((a, b) => b.estimatedBytes - a.estimatedBytes);
    const activeMs = artifacts.reduce<number | undefined>((newest, candidate) => {
      const active = lastActiveMs(candidate);
      return active === undefined ? newest : Math.max(newest ?? 0, active);
    }, undefined);
    const known = artifacts.some((candidate) => candidate.projectActiveMs !== undefined);
    const worktreeOf = artifacts.find((candidate) => candidate.worktreeOf)?.worktreeOf;
    const worktreeState = artifacts.find((candidate) => candidate.worktreeState)?.worktreeState;
    const section: ProjectSection =
      activeMs === undefined || !known
        ? "unknown"
        : worktreeState === "merged" && now - activeMs >= FINISHED_QUIET_MS
          ? "finished"
          : now - activeMs >= IDLE_SECTION_MS
            ? "idle"
            : "recent";
    const queueable = artifacts
      .filter((c) => c.riskTier === "safe" || c.riskTier === "caution")
      .map((c) => c.id);
    const name = basename(key) || key;
    projects.push({
      key,
      name,
      parent: projectWhere(key, targetDir, worktreeOf, worktreeState),
      section,
      activeMs,
      bytes: artifacts.reduce((sum, c) => sum + c.estimatedBytes, 0),
      queueableBytes: artifacts
        .filter((c) => c.riskTier === "safe" || c.riskTier === "caution")
        .reduce((sum, c) => sum + c.estimatedBytes, 0),
      guardedBytes: artifacts
        .filter((c) => c.riskTier === "dangerous" || c.riskTier === "blocked")
        .reduce((sum, c) => sum + c.estimatedBytes, 0),
      partial: artifacts.some((c) => c.bytesKnown === false),
      artifacts,
      queueable,
      selected: artifacts.filter((c) => selectedIds.has(c.id)).length,
      kinds: [...new Set(artifacts.map((c) => c.name))],
      caution: artifacts.filter((c) => c.riskTier === "caution").length,
      dangerous: artifacts.filter((c) => c.riskTier === "dangerous").length,
      ...(worktreeOf === undefined ? {} : { worktreeOf }),
      ...(worktreeState === undefined ? {} : { worktreeState }),
    });
  }
  // Largest reclaimable first: the order matches the size on the row.
  return projects.sort((a, b) => b.queueableBytes - a.queueableBytes || b.bytes - a.bytes);
}

// Finished worktrees first: the clearest space to give back reads first.
const SECTION_ORDER: ProjectSection[] = ["finished", "idle", "recent", "unknown"];

/** Flatten into screen rows: section headers, projects, and opened projects' artifacts. */
export function buildProjectRows(
  projects: readonly Project[],
  expanded: ReadonlySet<string>,
  openSections: ReadonlySet<ProjectSection> = new Set(),
  allArtifacts: ReadonlySet<string> = new Set(),
): ProjectRow[] {
  const rows: ProjectRow[] = [];
  for (const section of SECTION_ORDER) {
    const members = projects.filter((project) => project.section === section);
    if (members.length === 0) continue;
    if (rows.length > 0) rows.push({ kind: "spacer" });
    rows.push({
      kind: "section",
      section,
      bytes: members.reduce((sum, project) => sum + project.queueableBytes, 0),
      guardedBytes: members.reduce((sum, project) => sum + project.guardedBytes, 0),
      count: members.length,
    });
    // The biggest few first; the long tail of small projects waits behind one row.
    const shown = openSections.has(section) ? members : members.slice(0, SECTION_PREVIEW);
    for (const project of shown) {
      rows.push({ kind: "project", project });
      if (expanded.has(project.key)) {
        // Folding one or two rows saves nothing; fold only a real tail.
        const whole =
          allArtifacts.has(project.key) || project.artifacts.length <= ARTIFACT_PREVIEW + 2;
        const listed = whole ? project.artifacts : project.artifacts.slice(0, ARTIFACT_PREVIEW);
        for (const candidate of listed) rows.push({ kind: "artifact", project, candidate });
        const rest = project.artifacts.slice(listed.length);
        if (rest.length > 0) {
          rows.push({
            kind: "moreArtifacts",
            project,
            count: rest.length,
            bytes: rest.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
          });
        }
      }
    }
    const folded = members.slice(shown.length);
    if (folded.length > 0) {
      rows.push({
        kind: "more",
        section,
        count: folded.length,
        bytes: folded.reduce((sum, project) => sum + project.queueableBytes, 0),
      });
    }
  }
  return rows;
}

/** Rows the cursor can stop on. */
export function isFocusable(row: ProjectRow | undefined): boolean {
  return (
    row?.kind === "project" ||
    row?.kind === "artifact" ||
    row?.kind === "more" ||
    row?.kind === "moreArtifacts"
  );
}

/** Move the cursor `delta` focusable rows, clamped to the list. */
export function moveCursor(rows: readonly ProjectRow[], cursor: number, delta: number): number {
  const focusable = rows.flatMap((row, index) => (isFocusable(row) ? [index] : []));
  if (focusable.length === 0) return 0;
  const at = focusable.findIndex((index) => index >= cursor);
  const current = at < 0 ? focusable.length - 1 : at;
  const next = Math.max(0, Math.min(focusable.length - 1, current + delta));
  return focusable[next]!;
}

/** Keep the cursor on a real row after the list changes under it. */
export function settleCursor(rows: readonly ProjectRow[], cursor: number): number {
  if (isFocusable(rows[cursor])) return cursor;
  return moveCursor(rows, Math.min(cursor, rows.length - 1), 0);
}

/**
 * The disk's own answer beside the estimate. Far less than estimated is said
 * out loud: hardlinked installs and other volumes free less than they weigh.
 */
export function diskGainedText(receipt: {
  freedBytes: number;
  diskGained?: number | undefined;
}): string {
  const gained = receipt.diskGained ?? 0;
  if (gained < 0) return "";
  const text = `disk +${formatBytes(gained)}`;
  return receipt.freedBytes > 0 && gained < receipt.freedBytes * 0.5
    ? `${text} (hardlinks or another volume)`
    : text;
}
