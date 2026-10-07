import type { ScopeSidebarRow } from "./scope-tree.js";

/**
 * Per-row tree prefix, drawn from the rows that follow it.
 *
 * A folder tree only reads as a tree when the vertical guides are continuous,
 * and whether a guide continues at depth d depends on whether any *later* row
 * still sits at that depth. So prefixes are computed for the whole visible list
 * at once rather than per row.
 */
export function buildTreeGuides(rows: readonly ScopeSidebarRow[]): string[] {
  const guides: string[] = new Array(rows.length);
  // Walking backwards keeps the next sibling at each ancestor depth. A
  // shallower row ends all deeper sibling groups. Work is proportional to
  // the guides we produce, rather than repeatedly scanning whole subtrees.
  const nextSibling: boolean[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.depth === 0) {
      guides[i] = "";
      nextSibling.length = 0;
      continue;
    }

    // One trunk segment per ancestor level between the root and this node's
    // parent: the guide keeps running only while that ancestor still has
    // siblings below. Then the node's own connector, which is a corner when
    // nothing else at this depth follows.
    const trunk: string[] = [];
    for (let d = 1; d < row.depth; d++) {
      trunk.push(nextSibling[d] ? "│ " : "  ");
    }
    trunk.push(nextSibling[row.depth] ? "├─" : "└─");
    guides[i] = trunk.join("");
    nextSibling.length = row.depth + 1;
    nextSibling[row.depth] = true;
  }

  return guides;
}

/**
 * Every folder key on the path to `scopeFilter`, so the tree can open itself
 * down to the active scope instead of stranding it behind collapsed parents.
 */
export function ancestorKeysOf(scopeFilter: string | null): string[] {
  if (scopeFilter === null || scopeFilter.length === 0) return [];
  const parts = scopeFilter.split("/").filter((part) => part.length > 0);
  const keys: string[] = [];
  let acc = "";
  // The scope itself is included: opening it reveals what is inside it.
  for (const part of parts) {
    acc = acc.length === 0 ? part : `${acc}/${part}`;
    keys.push(acc);
  }
  return keys;
}
