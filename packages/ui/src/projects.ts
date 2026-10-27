import { basename, dirname } from "node:path";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { lastActiveMs } from "./age.js";

/**
 * The projects view: one row per project, sorted into what nobody is using
 * and what someone is. It answers the question sweep is opened with - what
 * can I clean? - before any artifact row is read. Artifacts stay one Enter
 * away.
 */

export const IDLE_SECTION_MS = 30 * 86_400_000;

export type ProjectSection = "idle" | "recent" | "unknown";

export const SECTION_TITLE: Record<ProjectSection, string> = {
  idle: "Idle 30+ days",
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
  /** Bytes that a project-level queue would take: safe and caution only. */
  queueableBytes: number;
  partial: boolean;
  artifacts: ScanCandidate[];
  /** Ids a project-level space queues: never dangerous or blocked. */
  queueable: string[];
  selected: number;
  kinds: string[];
}

export type ProjectRow =
  | { kind: "section"; section: ProjectSection; bytes: number; count: number }
  | { kind: "project"; project: Project }
  | { kind: "artifact"; project: Project; candidate: ScanCandidate }
  | { kind: "more"; section: ProjectSection; count: number; bytes: number }
  | { kind: "spacer" };

/** Projects shown per section before the rest folds into one "+ N more" row. */
export const SECTION_PREVIEW = 8;

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
    const section: ProjectSection =
      activeMs === undefined || !known
        ? "unknown"
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
      parent: relativeParent(key, targetDir),
      section,
      activeMs,
      bytes: artifacts.reduce((sum, c) => sum + c.estimatedBytes, 0),
      queueableBytes: artifacts
        .filter((c) => c.riskTier === "safe" || c.riskTier === "caution")
        .reduce((sum, c) => sum + c.estimatedBytes, 0),
      partial: artifacts.some((c) => c.bytesKnown === false),
      artifacts,
      queueable,
      selected: artifacts.filter((c) => selectedIds.has(c.id)).length,
      kinds: [...new Set(artifacts.map((c) => c.name))],
    });
  }
  return projects.sort((a, b) => b.bytes - a.bytes);
}

const SECTION_ORDER: ProjectSection[] = ["idle", "recent", "unknown"];

/** Flatten into screen rows: section headers, projects, and opened projects' artifacts. */
export function buildProjectRows(
  projects: readonly Project[],
  expanded: ReadonlySet<string>,
  openSections: ReadonlySet<ProjectSection> = new Set(),
): ProjectRow[] {
  const rows: ProjectRow[] = [];
  for (const section of SECTION_ORDER) {
    const members = projects.filter((project) => project.section === section);
    if (members.length === 0) continue;
    if (rows.length > 0) rows.push({ kind: "spacer" });
    rows.push({
      kind: "section",
      section,
      bytes: members.reduce((sum, project) => sum + project.bytes, 0),
      count: members.length,
    });
    // The biggest few first; the long tail of small projects waits behind one row.
    const shown = openSections.has(section) ? members : members.slice(0, SECTION_PREVIEW);
    for (const project of shown) {
      rows.push({ kind: "project", project });
      if (expanded.has(project.key)) {
        for (const candidate of project.artifacts)
          rows.push({ kind: "artifact", project, candidate });
      }
    }
    const folded = members.slice(shown.length);
    if (folded.length > 0) {
      rows.push({
        kind: "more",
        section,
        count: folded.length,
        bytes: folded.reduce((sum, project) => sum + project.bytes, 0),
      });
    }
  }
  return rows;
}

/** Rows the cursor can stop on. */
export function isFocusable(row: ProjectRow | undefined): boolean {
  return row?.kind === "project" || row?.kind === "artifact" || row?.kind === "more";
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
