import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { candidateIndex } from "./candidate-index.js";
import { groupCandidatesByScope, type ArtifactScopeGroup } from "./grouping.js";
import { relativePath } from "./presentation.js";

export interface ScopeSidebarRow {
  /** `null` means all scopes. */
  key: string | null;
  label: string;
  /** Indent level in the folder tree (`all scopes` is 0). */
  depth: number;
  hasChildren: boolean;
  count: number;
  selectedCount: number;
  bytes: number;
  selectedBytes: number;
}

interface TrieNode {
  segment: string;
  key: string;
  ids: string[];
  children: Map<string, TrieNode>;
}

function emptyNode(segment: string, key: string): TrieNode {
  return { segment, key, ids: [], children: new Map() };
}

const MAX_SCOPE_NODES = 100_000;
const MAX_SCOPE_KEY_BYTES = 16 * 1024 * 1024;
interface ScopeBudget {
  nodes: number;
  keyBytes: number;
}

function insertGroup(root: TrieNode, group: ArtifactScopeGroup, budget: ScopeBudget): boolean {
  if (group.key.length === 0) {
    for (const id of group.candidateIds) root.ids.push(id);
    return true;
  }

  const parts = group.key.split("/").filter((part) => part.length > 0);
  let node = root;
  let acc = "";
  for (const part of parts) {
    acc = acc.length === 0 ? part : `${acc}/${part}`;
    let child = node.children.get(part);
    if (!child) {
      budget.nodes++;
      budget.keyBytes += Buffer.byteLength(acc);
      if (budget.nodes > MAX_SCOPE_NODES || budget.keyBytes > MAX_SCOPE_KEY_BYTES) return false;
      child = emptyNode(part, acc);
      node.children.set(part, child);
    }
    node = child;
  }
  for (const id of group.candidateIds) node.ids.push(id);
  return true;
}

/** Iterative postorder avoids call-stack overflow on deep folder chains. */
function* postorder(root: TrieNode): Generator<TrieNode> {
  const pending: Array<[TrieNode, boolean]> = [[root, false]];
  while (pending.length) {
    const [node, ready] = pending.pop()!;
    if (ready) {
      yield node;
      continue;
    }
    pending.push([node, true]);
    for (const child of node.children.values()) pending.push([child, false]);
  }
}

/** Collapse single-child folder chains the way trees.software flattens empty dirs. */
export function flattenTrieNode(root: TrieNode): void {
  for (const node of postorder(root)) {
    while (node.key.length > 0 && node.ids.length === 0 && node.children.size === 1) {
      const child = node.children.values().next().value;
      if (!child) break;
      node.segment = `${node.segment}/${child.segment}`;
      node.key = child.key;
      node.ids = child.ids;
      node.children = child.children;
    }
  }
}

interface Stats {
  count: number;
  bytes: number;
  selectedCount: number;
  selectedBytes: number;
}

// One postorder pass per selection, rather than repeatedly walking subtrees
// for every comparator and visible row. Structural order is cached separately.
function aggregate(
  node: TrieNode,
  byId: ReadonlyMap<string, ScanCandidate>,
  selected: Set<string>,
  stats: Map<TrieNode, Stats>,
): Stats {
  for (const current of postorder(node)) {
    const result: Stats = { count: 0, bytes: 0, selectedCount: 0, selectedBytes: 0 };
    for (const id of current.ids) {
      const c = byId.get(id);
      if (!c) continue;
      result.count++;
      result.bytes += c.estimatedBytes;
      if (selected.has(id)) {
        result.selectedCount++;
        result.selectedBytes += c.estimatedBytes;
      }
    }
    for (const child of current.children.values()) {
      const value = stats.get(child)!;
      result.count += value.count;
      result.bytes += value.bytes;
      result.selectedCount += value.selectedCount;
      result.selectedBytes += value.selectedBytes;
    }
    stats.set(current, result);
  }
  return stats.get(node)!;
}

let topology: {
  targetDir: string;
  candidates: ScanCandidate[];
  root: TrieNode;
  tops: TrieNode[];
  byId: ReadonlyMap<string, ScanCandidate>;
  children: Map<TrieNode, TrieNode[]>;
  limited: boolean;
} | null = null;

// Rebuilt per render otherwise - tuple-keyed single-slot cache, same pattern
// as the display-rows cache in rows.ts.
let treeLast: {
  targetDir: string;
  candidates: ScanCandidate[];
  selectedIds: ReadonlySet<string>;
  expandedKeys: ReadonlySet<string>;
  rows: ScopeSidebarRow[];
} | null = null;

export function clearScopeTreeCache(): void {
  topology = null;
  treeLast = null;
  scopeKeyTarget = null;
  scopeKeyCache.clear();
}

/** Visible sidebar rows: all-scopes, then an indented folder tree. */
export function buildScopeTreeRows(
  targetDir: string,
  candidates: ScanCandidate[],
  selectedIds: Set<string>,
  expandedKeys: ReadonlySet<string>,
): ScopeSidebarRow[] {
  if (
    treeLast &&
    treeLast.targetDir === targetDir &&
    treeLast.candidates === candidates &&
    treeLast.selectedIds === selectedIds &&
    treeLast.expandedKeys === expandedKeys
  ) {
    return treeLast.rows;
  }
  const rows = computeScopeTreeRows(targetDir, candidates, selectedIds, expandedKeys);
  treeLast = { targetDir, candidates, selectedIds, expandedKeys, rows };
  return rows;
}

function computeScopeTreeRows(
  targetDir: string,
  candidates: ScanCandidate[],
  selectedIds: Set<string>,
  expandedKeys: ReadonlySet<string>,
): ScopeSidebarRow[] {
  const orderChanged =
    !topology || topology.targetDir !== targetDir || topology.candidates !== candidates;
  const sameShape =
    orderChanged &&
    topology &&
    topology.targetDir === targetDir &&
    topology.candidates.length === candidates.length &&
    topology.candidates.every(
      (previous, i) => previous.id === candidates[i]!.id && previous.path === candidates[i]!.path,
    );
  if (orderChanged && sameShape && topology) {
    // Sizing replaces immutable candidate records, not folder topology. Keep
    // the trie and refresh its observations instead of allocating every node.
    topology.byId = candidateIndex(candidates);
    topology.candidates = candidates;
  } else if (orderChanged) {
    const groups = groupCandidatesByScope(targetDir, candidates, undefined, {
      maxGroups: Number.POSITIVE_INFINITY,
    });
    const byId = candidateIndex(candidates);
    const root = emptyNode("", "");
    const budget: ScopeBudget = { nodes: 0, keyBytes: 0 };
    let limited = false;
    for (const group of groups) {
      if (!insertGroup(root, group, budget)) {
        limited = true;
        break;
      }
    }
    if (limited) {
      // Keep every candidate available in the main list. Only the optional
      // folder index is suppressed, with explicit feedback on its sole row.
      root.children.clear();
      root.ids = candidates.map((candidate) => candidate.id);
    }
    flattenTrieNode(root);
    topology = { targetDir, candidates, root, tops: [], byId, children: new Map(), limited };
  }
  if (!topology) return [];
  const { root, byId } = topology;
  const stats = new Map<TrieNode, Stats>();
  const all = aggregate(root, byId, selectedIds, stats);
  if (orderChanged) {
    const children = new Map<TrieNode, TrieNode[]>();
    const compare = (a: TrieNode, b: TrieNode) =>
      stats.get(b)!.bytes - stats.get(a)!.bytes || a.segment.localeCompare(b.segment);
    for (const node of stats.keys()) {
      if (node.children.size) children.set(node, [...node.children.values()].sort(compare));
    }
    const tops = [...(children.get(root) ?? [])];
    if (root.ids.length && !topology.limited) {
      const synthetic = emptyNode("project root", "");
      synthetic.ids = root.ids;
      aggregate(synthetic, byId, selectedIds, stats);
      tops.push(synthetic);
      tops.sort(compare);
    }
    topology.children = children;
    topology.tops = tops;
  }
  const { tops, children } = topology;
  const rows: ScopeSidebarRow[] = [
    {
      key: null,
      label: topology.limited ? "all scopes (folder index limit)" : "all scopes",
      depth: 0,
      hasChildren: false,
      ...all,
    },
  ];
  const pending = tops
    .slice()
    .reverse()
    .map((node) => ({ node, depth: 0 }));
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    const values = stats.get(node) ?? aggregate(node, byId, selectedIds, stats);
    const hasChildren = node.children.size > 0;
    rows.push({
      key: node.key,
      label: node.key === "" ? "project root" : `${node.segment}/`,
      depth,
      hasChildren,
      ...values,
    });
    if (hasChildren && expandedKeys.has(node.key)) {
      const nested = children.get(node) ?? [];
      for (let i = nested.length - 1; i >= 0; i--)
        pending.push({ node: nested[i]!, depth: depth + 1 });
    }
  }

  return rows;
}

/**
 * `path.relative` per candidate per render was the hot-spot on large scans.
 * Candidate paths are immutable strings, so the scope key caches by content;
 * the map resets when the target changes instead of growing across rescans.
 */
let scopeKeyTarget: string | null = null;
const scopeKeyCache = new Map<string, string>();

/** Parent directory of an artifact, relative to the scan root. Empty = project root. */
export function artifactScopeKey(targetDir: string, path: string): string {
  if (targetDir !== scopeKeyTarget) {
    scopeKeyCache.clear();
    scopeKeyTarget = targetDir;
  }
  const cached = scopeKeyCache.get(path);
  if (cached !== undefined) return cached;
  const rel = relativePath(targetDir, path).replaceAll("\\", "/");
  const slash = rel.lastIndexOf("/");
  const key = slash <= 0 ? "" : rel.slice(0, slash);
  // Keep content cache bounded across rescans of the same root.
  if (scopeKeyCache.size >= 100_000) scopeKeyCache.clear();
  scopeKeyCache.set(path, key);
  return key;
}

/** Prefix match so a folder scope includes every nested artifact. */
export function candidateMatchesScope(parentKey: string, scopeFilter: string | null): boolean {
  if (scopeFilter === null) return true;
  if (scopeFilter === "") return parentKey === "";
  return parentKey === scopeFilter || parentKey.startsWith(`${scopeFilter}/`);
}

export function isScopeAncestor(rowKey: string | null, scopeFilter: string | null): boolean {
  if (rowKey === null || scopeFilter === null || scopeFilter === "") return false;
  if (rowKey === "") return true;
  return scopeFilter === rowKey || scopeFilter.startsWith(`${rowKey}/`);
}
