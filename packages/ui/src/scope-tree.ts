import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
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

function insertGroup(root: TrieNode, group: ArtifactScopeGroup): void {
  if (group.key.length === 0) {
    root.ids.push(...group.candidateIds);
    return;
  }

  const parts = group.key.split("/").filter((part) => part.length > 0);
  let node = root;
  let acc = "";
  for (const part of parts) {
    acc = acc.length === 0 ? part : `${acc}/${part}`;
    let child = node.children.get(part);
    if (!child) {
      child = emptyNode(part, acc);
      node.children.set(part, child);
    }
    node = child;
  }
  node.ids.push(...group.candidateIds);
}

/** Collapse single-child folder chains the way trees.software flattens empty dirs. */
export function flattenTrieNode(node: TrieNode): void {
  for (const child of node.children.values()) flattenTrieNode(child);

  while (node.key.length > 0 && node.ids.length === 0 && node.children.size === 1) {
    const child = node.children.values().next().value;
    if (!child) break;
    node.segment = `${node.segment}/${child.segment}`;
    node.key = child.key;
    node.ids = child.ids;
    node.children = child.children;
  }
}

function subtreeStats(
  node: TrieNode,
  byId: Map<string, ScanCandidate>,
  selectedIds: Set<string>,
): { count: number; bytes: number; selectedCount: number; selectedBytes: number } {
  let count = 0;
  let bytes = 0;
  let selectedCount = 0;
  let selectedBytes = 0;

  const visit = (current: TrieNode) => {
    for (const id of current.ids) {
      const candidate = byId.get(id);
      if (!candidate) continue;
      count += 1;
      bytes += candidate.estimatedBytes;
      if (selectedIds.has(id)) {
        selectedCount += 1;
        selectedBytes += candidate.estimatedBytes;
      }
    }
    for (const child of current.children.values()) visit(child);
  };

  visit(node);
  return { count, bytes, selectedCount, selectedBytes };
}

function emitVisible(
  node: TrieNode,
  depth: number,
  expanded: Set<string>,
  byId: Map<string, ScanCandidate>,
  selectedIds: Set<string>,
  rows: ScopeSidebarRow[],
): void {
  const stats = subtreeStats(node, byId, selectedIds);
  const hasChildren = node.children.size > 0;
  rows.push({
    key: node.key,
    label: node.key.length === 0 ? "project root" : `${node.segment}/`,
    depth,
    hasChildren,
    count: stats.count,
    selectedCount: stats.selectedCount,
    bytes: stats.bytes,
    selectedBytes: stats.selectedBytes,
  });

  if (!hasChildren || !expanded.has(node.key)) return;
  for (const child of sortedChildren(node, byId)) {
    emitVisible(child, depth + 1, expanded, byId, selectedIds, rows);
  }
}

function nodeBytes(node: TrieNode, byId: Map<string, ScanCandidate>): number {
  let total = 0;
  for (const id of node.ids) total += byId.get(id)?.estimatedBytes ?? 0;
  for (const child of node.children.values()) total += nodeBytes(child, byId);
  return total;
}

function sortedChildren(node: TrieNode, byId: Map<string, ScanCandidate>): TrieNode[] {
  return [...node.children.values()].sort((left, right) => {
    const delta = nodeBytes(right, byId) - nodeBytes(left, byId);
    return delta !== 0 ? delta : left.segment.localeCompare(right.segment);
  });
}

/** Visible sidebar rows: all-scopes, then an indented folder tree. */
export function buildScopeTreeRows(
  targetDir: string,
  candidates: ScanCandidate[],
  selectedIds: Set<string>,
  expandedKeys: ReadonlySet<string>,
): ScopeSidebarRow[] {
  const groups = groupCandidatesByScope(targetDir, candidates, undefined, {
    maxGroups: Number.POSITIVE_INFINITY,
  });
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const root = emptyNode("", "");
  for (const group of groups) insertGroup(root, group);
  flattenTrieNode(root);

  const rows: ScopeSidebarRow[] = [
    {
      key: null,
      label: "all scopes",
      depth: 0,
      hasChildren: false,
      count: candidates.length,
      selectedCount: candidates.filter((candidate) => selectedIds.has(candidate.id)).length,
      bytes: candidates.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
      selectedBytes: candidates
        .filter((candidate) => selectedIds.has(candidate.id))
        .reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
    },
  ];

  const tops: TrieNode[] = sortedChildren(root, byId);
  if (root.ids.length > 0) {
    const synthetic = emptyNode("project root", "");
    synthetic.ids = root.ids;
    tops.push(synthetic);
    tops.sort((left, right) => {
      const delta = nodeBytes(right, byId) - nodeBytes(left, byId);
      return delta !== 0 ? delta : left.segment.localeCompare(right.segment);
    });
  }

  for (const child of tops) {
    emitVisible(child, 0, new Set(expandedKeys), byId, selectedIds, rows);
  }

  return rows;
}

/** Parent directory of an artifact, relative to the scan root. Empty = project root. */
export function artifactScopeKey(targetDir: string, path: string): string {
  const rel = relativePath(targetDir, path).replaceAll("\\", "/");
  const slash = rel.lastIndexOf("/");
  if (slash <= 0) return "";
  return rel.slice(0, slash);
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
