import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { relativePath } from "./presentation.js";

export interface ScopeSidebarRow {
  key: string | null;
  label: string;
  depth: number;
  hasChildren: boolean;
  count: number;
  selectedCount: number;
  bytes: number;
  selectedBytes: number;
}
interface Stats {
  count: number;
  bytes: number;
  selectedCount: number;
  selectedBytes: number;
}
interface Node {
  segment: string;
  key: string;
  parent: Node | null;
  ownCount: number;
  children: Map<string, Node> | null;
  stats: Stats;
  sorted: Node[] | undefined;
  compressed: { end: Node; label: string } | undefined;
  row: ScopeSidebarRow | undefined;
}
function emptyNode(segment: string, key: string, parent: Node | null): Node {
  return {
    segment,
    key,
    parent,
    ownCount: 0,
    children: null,
    stats: { count: 0, bytes: 0, selectedCount: 0, selectedBytes: 0 },
    sorted: undefined,
    compressed: undefined,
    row: undefined,
  };
}
const MAX_SCOPE_NODES = 100_000;
const MAX_SCOPE_KEY_BYTES = 16 * 1024 * 1024;
interface ScopeIndex {
  targetDir: string;
  candidates: ScanCandidate[];
  selectedIds: ReadonlySet<string>;
  root: Node;
  owners: Node[];
  nodes: number;
  keyBytes: number;
  limited: boolean;
}
let topology: ScopeIndex | null = null;
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

/** Keep the uncompressed tree so a later sibling can split a displayed chain.
 * Compression is a view, not a destructive rewrite of the discovery index. */
function compressed(node: Node): { end: Node; label: string } {
  if (node.compressed) return node.compressed;
  let end = node;
  const labels = [node.segment];
  while (end.key.length > 0 && end.ownCount === 0 && end.children?.size === 1) {
    end = end.children.values().next().value!;
    labels.push(end.segment);
  }
  node.compressed = { end, label: labels.join("/") };
  return node.compressed;
}
function invalidateStructure(node: Node): void {
  for (let current: Node | null = node; current; current = current.parent) {
    current.compressed = undefined;
    current.sorted = undefined;
  }
}
function ownerFor(index: ScopeIndex, candidate: ScanCandidate): Node | undefined {
  const key = artifactScopeKey(index.targetDir, candidate.path);
  if (!key) {
    let direct = index.root.children?.get("");
    if (!direct) {
      direct = emptyNode("project root", "", index.root);
      (index.root.children ??= new Map()).set("", direct);
    }
    return direct;
  }
  let node = index.root;
  let acc = "";
  for (const part of key.split("/").filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part;
    let child = node.children?.get(part);
    if (!child) {
      index.nodes++;
      index.keyBytes += Buffer.byteLength(acc);
      if (index.nodes > MAX_SCOPE_NODES || index.keyBytes > MAX_SCOPE_KEY_BYTES) return undefined;
      child = emptyNode(part, acc, node);
      (node.children ??= new Map()).set(part, child);
    }
    node = child;
  }
  return node;
}
function addStats(owner: Node, delta: Stats): void {
  if (
    delta.count === 0 &&
    delta.bytes === 0 &&
    delta.selectedCount === 0 &&
    delta.selectedBytes === 0
  )
    return;
  for (let node: Node | null = owner; node; node = node.parent) {
    node.stats.count += delta.count;
    node.stats.bytes += delta.bytes;
    node.stats.selectedCount += delta.selectedCount;
    node.stats.selectedBytes += delta.selectedBytes;
    if (delta.bytes !== 0 && node.parent) node.parent.sorted = undefined;
  }
}
function syncIndex(
  targetDir: string,
  candidates: ScanCandidate[],
  selectedIds: Set<string>,
): ScopeIndex {
  const old = topology;
  const compatible =
    old &&
    old.targetDir === targetDir &&
    old.candidates.length <= candidates.length &&
    old.candidates.every(
      (candidate, i) =>
        candidate.id === candidates[i]!.id && candidate.path === candidates[i]!.path,
    );
  if (!compatible)
    topology = {
      targetDir,
      candidates: [],
      selectedIds: new Set(),
      root: emptyNode("", "", null),
      owners: [],
      nodes: 0,
      keyBytes: 0,
      limited: false,
    };
  const index = topology!;
  if (!index.limited) {
    const oldCount = index.candidates.length;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      const previous = index.candidates[i];
      const wasSelected = previous !== undefined && index.selectedIds.has(previous.id);
      const selected = selectedIds.has(candidate.id);
      let owner = index.owners[i];
      if (i >= oldCount) {
        owner = ownerFor(index, candidate);
        if (!owner) {
          // Discard the partial optional index. All artifacts remain visible
          // and reviewable in the main list; aggregate fallback stays honest.
          index.limited = true;
          index.root = emptyNode("", "", null);
          index.owners = [];
          break;
        }
        index.owners.push(owner);
        if (owner.ownCount === 0) invalidateStructure(owner);
        owner.ownCount++;
      }
      addStats(owner!, {
        count: previous === undefined ? 1 : 0,
        bytes: candidate.estimatedBytes - (previous?.estimatedBytes ?? 0),
        selectedCount: Number(selected) - Number(wasSelected),
        selectedBytes:
          (selected ? candidate.estimatedBytes : 0) - (wasSelected ? previous!.estimatedBytes : 0),
      });
    }
  }
  if (index.limited) {
    const stats: Stats = { count: candidates.length, bytes: 0, selectedCount: 0, selectedBytes: 0 };
    for (const candidate of candidates) {
      stats.bytes += candidate.estimatedBytes;
      if (selectedIds.has(candidate.id)) {
        stats.selectedCount++;
        stats.selectedBytes += candidate.estimatedBytes;
      }
    }
    index.root.stats = stats;
  }
  index.candidates = candidates;
  index.selectedIds = selectedIds;
  return index;
}
function sortedChildren(node: Node): Node[] {
  if (!node.sorted)
    node.sorted = [...(node.children?.values() ?? [])].sort(
      (a, b) =>
        b.stats.bytes - a.stats.bytes ||
        compressed(a).label.localeCompare(compressed(b).label) ||
        (a.key === "" ? 1 : b.key === "" ? -1 : 0),
    );
  return node.sorted;
}
function snapshotRow(
  node: Node,
  key: string | null,
  label: string,
  depth: number,
  hasChildren: boolean,
  stats: Stats,
): ScopeSidebarRow {
  const old = node.row;
  if (
    old &&
    old.key === key &&
    old.label === label &&
    old.depth === depth &&
    old.hasChildren === hasChildren &&
    old.count === stats.count &&
    old.bytes === stats.bytes &&
    old.selectedCount === stats.selectedCount &&
    old.selectedBytes === stats.selectedBytes
  )
    return old;
  node.row = { key, label, depth, hasChildren, ...stats };
  return node.row;
}

/** Incremental observations and immutable rows. A frame only creates nodes for
 * new paths and replaces changed row snapshots; selection/size deltas reach
 * their ancestors without allocating a full-tree aggregate Map. */
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
  )
    return treeLast.rows;
  const index = syncIndex(targetDir, candidates, selectedIds);
  const rows = [
    snapshotRow(
      index.root,
      null,
      index.limited ? "all scopes (folder index limit)" : "all scopes",
      0,
      false,
      index.root.stats,
    ),
  ];
  if (!index.limited) {
    const pending: Array<{ node: Node; depth: number }> = [];
    const tops = sortedChildren(index.root);
    for (let i = tops.length - 1; i >= 0; i--) pending.push({ node: tops[i]!, depth: 0 });
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      const { end, label } = compressed(node);
      const hasChildren = (end.children?.size ?? 0) > 0;
      rows.push(
        snapshotRow(
          node,
          end.key,
          end.key === "" ? "project root" : `${label}/`,
          depth,
          hasChildren,
          end.stats,
        ),
      );
      if (hasChildren && expandedKeys.has(end.key)) {
        const children = sortedChildren(end);
        for (let i = children.length - 1; i >= 0; i--)
          pending.push({ node: children[i]!, depth: depth + 1 });
      }
    }
  }
  treeLast = { targetDir, candidates, selectedIds, expandedKeys, rows };
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
  const rel = relativePath(targetDir, path);
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
