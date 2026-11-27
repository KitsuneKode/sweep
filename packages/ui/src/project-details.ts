import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { catalogEntryFor } from "@kitsunekode/sweep-core/catalog";
import type { CandidateKind, ScanCandidate } from "@kitsunekode/sweep-protocol";
import type { Project } from "./projects.js";

/**
 * What it costs to get an artifact back, in the three amounts that decide a
 * removal: a cache refills by itself, an install needs the network or a
 * package store, a build spends CPU. The command is what brings it back.
 */
export type RebuildCost = "cache" | "install" | "build" | "unknown";

export interface Rebuild {
  cost: RebuildCost;
  /** How it comes back, short enough for a 40-cell panel. */
  how: string;
}

/** Which package manager reinstalls node_modules here, from its lockfile. */
export function packageManager(root: string): string {
  const has = (file: string) => existsSync(join(root, file));
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  return "npm";
}

const rebuildCache = new Map<string, Rebuild>();

export function rebuildFor(kind: CandidateKind, root: string, name?: string): Rebuild {
  const key = `${kind}\0${root}\0${name ?? ""}`;
  const cached = rebuildCache.get(key);
  if (cached) return cached;
  const rebuild = readRebuild(kind, root, name);
  rebuildCache.set(key, rebuild);
  return rebuild;
}

function readRebuild(kind: CandidateKind, root: string, name?: string): Rebuild {
  switch (kind) {
    case "node_modules":
      return { cost: "install", how: `${packageManager(root)} install` };
    case "target":
      if (existsSync(join(root, "Cargo.toml"))) return { cost: "build", how: "cargo build" };
      if (existsSync(join(root, "pom.xml"))) return { cost: "build", how: "mvn package" };
      return { cost: "build", how: "the project's build" };
    case ".next":
      return { cost: "build", how: "next build or next dev" };
    case ".nuxt":
      return { cost: "build", how: "nuxt build or nuxt dev" };
    case ".svelte-kit":
      return { cost: "build", how: "vite dev or vite build" };
    case "dist":
    case "build":
    case "out":
      return { cost: "build", how: "the project's build" };
    case ".turbo":
      return { cost: "cache", how: "turbo refills it" };
    case ".vite":
      return { cost: "cache", how: "vite refills it" };
    case ".parcel-cache":
      return { cost: "cache", how: "parcel refills it" };
    case "tsbuildinfo":
      return { cost: "cache", how: "tsc refills it" };
    case "coverage":
    case ".nyc_output":
      return { cost: "cache", how: "the next coverage run" };
    default: {
      // Opt-in names the catalog knows (.venv, __pycache__...) carry their own
      // note; only a pattern the user wrote is "your pattern".
      const note = name ? catalogEntryFor(name)?.note : undefined;
      return { cost: "unknown", how: note ?? "your pattern" };
    }
  }
}

const GIT_META_MAX_BYTES = 4096;

function readSmallNoFollow(filePath: string, maxBytes = GIT_META_MAX_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    const lmeta = lstatSync(filePath);
    if (!lmeta.isFile() || lmeta.isSymbolicLink() || lmeta.size > maxBytes) return undefined;
    const flags =
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    fd = openSync(filePath, flags);
    const fmeta = fstatSync(fd);
    if (!fmeta.isFile() || fmeta.size > maxBytes) return undefined;
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const n = readSync(fd, buffer, total, maxBytes + 1 - total, null);
      if (n === 0) break;
      total += n;
    }
    if (total > maxBytes) return undefined;
    return buffer.subarray(0, total).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close error on read-only descriptor.
      }
    }
  }
}

/** The branch a work tree has checked out, read from HEAD; never runs git. */
export function gitBranch(root: string): string | null {
  try {
    let gitDir = join(root, ".git");
    const meta = lstatSync(gitDir);
    if (meta.isSymbolicLink()) return null;
    // A linked worktree or submodule keeps a file pointing at its git dir.
    if (meta.isFile()) {
      const pointerText = readSmallNoFollow(gitDir);
      if (pointerText === undefined) return null;
      const firstLine = pointerText.split(/\r?\n/, 1)[0] ?? "";
      const pointer = /^gitdir:\s*(.+)$/.exec(firstLine);
      const target = pointer?.[1]?.trim();
      if (!target) return null;
      gitDir = isAbsolute(target) ? target : resolve(root, target);
    } else if (!meta.isDirectory()) {
      return null;
    }
    const headText = readSmallNoFollow(join(gitDir, "HEAD"));
    if (headText === undefined) return null;
    const head = headText.trim();
    if (!head) return null;
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref?.[1] ?? `detached ${head.slice(0, 7)}`;
  } catch {
    return null;
  }
}

export interface KindGroup {
  name: string;
  bytes: number;
  count: number;
  queued: number;
  rebuild: Rebuild;
}

/** Artifacts folded by name, biggest first: what the project holds, and what each costs. */
export function kindGroups(project: Project, selectedIds: ReadonlySet<string>): KindGroup[] {
  const groups = new Map<string, KindGroup>();
  for (const candidate of project.artifacts) {
    const group = groups.get(candidate.name) ?? {
      name: candidate.name,
      bytes: 0,
      count: 0,
      queued: 0,
      rebuild: rebuildFor(candidate.kind, project.key, candidate.name),
    };
    group.bytes += candidate.estimatedBytes;
    group.count += 1;
    if (selectedIds.has(candidate.id)) group.queued += 1;
    groups.set(candidate.name, group);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

export interface ProjectFacts {
  branch: string | null;
  groups: KindGroup[];
  queuedBytes: number;
}

/**
 * Facts read from disk (HEAD, lockfiles, manifests) are cached per project
 * for the session: the panel re-renders on every cursor move, and a branch
 * switch under an open sweep is not worth a read per keystroke.
 */
const branchCache = new Map<string, string | null>();

export function projectFacts(project: Project, selectedIds: ReadonlySet<string>): ProjectFacts {
  let branch = branchCache.get(project.key);
  if (branch === undefined) {
    branch = gitBranch(project.key);
    branchCache.set(project.key, branch);
  }
  return {
    branch,
    groups: kindGroups(project, selectedIds),
    queuedBytes: project.artifacts.reduce(
      (sum: number, candidate: ScanCandidate) =>
        selectedIds.has(candidate.id) ? sum + candidate.estimatedBytes : sum,
      0,
    ),
  };
}

export interface CostShare {
  cost: RebuildCost;
  /** Reclaimable (safe + caution) bytes that cost this much to bring back. */
  bytes: number;
  /** The part of them that is queued. */
  queuedBytes: number;
}

const COST_ORDER: RebuildCost[] = ["cache", "install", "build", "unknown"];

/**
 * Everything reclaimable, split by what it costs to get back, cheapest first:
 * the left of the hero bar is the easy win. Guarded items are never counted.
 */
export function reclaimByCost(
  projects: readonly Project[],
  selectedIds: ReadonlySet<string>,
): CostShare[] {
  const totals = new Map<RebuildCost, CostShare>();
  for (const project of projects) {
    for (const candidate of project.artifacts) {
      if (candidate.riskTier !== "safe" && candidate.riskTier !== "caution") continue;
      const cost = rebuildFor(candidate.kind, project.key, candidate.name).cost;
      const share = totals.get(cost) ?? { cost, bytes: 0, queuedBytes: 0 };
      share.bytes += candidate.estimatedBytes;
      if (selectedIds.has(candidate.id)) share.queuedBytes += candidate.estimatedBytes;
      totals.set(cost, share);
    }
  }
  return COST_ORDER.flatMap((cost) => {
    const share = totals.get(cost);
    return share && share.bytes > 0 ? [share] : [];
  });
}

/**
 * One line for the confirm: what the queue costs to bring back, by kind of
 * cost, with the command for the biggest of each ("install 5.0 GiB (bun
 * install) · build 3.0 GiB (cargo build)"). Guarded items are not hidden here:
 * the confirm is about everything that will actually be removed.
 */
export function rebuildSummary(
  candidates: readonly ScanCandidate[],
  format: (bytes: number) => string,
): string {
  const groups = new Map<RebuildCost, { bytes: number; how: string; top: number }>();
  for (const candidate of candidates) {
    const rebuild = rebuildFor(
      candidate.kind,
      candidate.projectRoot ?? dirname(candidate.path),
      candidate.name,
    );
    const group = groups.get(rebuild.cost) ?? { bytes: 0, how: rebuild.how, top: -1 };
    group.bytes += candidate.estimatedBytes;
    if (candidate.estimatedBytes > group.top) {
      group.top = candidate.estimatedBytes;
      group.how = rebuild.how;
    }
    groups.set(rebuild.cost, group);
  }
  return COST_ORDER.flatMap((cost) => {
    const group = groups.get(cost);
    if (!group || group.bytes <= 0) return [];
    const label = cost === "unknown" ? "custom" : cost;
    return [`${label} ${format(group.bytes)}${cost === "unknown" ? "" : ` (${group.how})`}`];
  }).join(" · ");
}
