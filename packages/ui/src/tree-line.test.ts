import { describe, expect, test } from "bun:test";
import type { ScopeSidebarRow } from "./scope-tree.js";
import { ancestorKeysOf, buildTreeGuides } from "./tree-line.js";

function row(key: string, depth: number): ScopeSidebarRow {
  return {
    key,
    label: `${key}/`,
    depth,
    hasChildren: false,
    count: 1,
    selectedCount: 0,
    bytes: 0,
    selectedBytes: 0,
  };
}

describe("buildTreeGuides", () => {
  test("a wide nested folder does not repeatedly search its remaining siblings", () => {
    const input = [row("a", 0), row("a/x", 1)];
    for (let i = 0; i < 512; i++) input.push(row(`a/x/${i}`, 2));
    let reads = 0;
    const rows = new Proxy(input, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const guides = buildTreeGuides(rows);
    expect(guides[2]).toBe("  ├─");
    expect(guides.at(-1)).toBe("  └─");
    expect(reads).toBeLessThan(input.length * 8);
  });

  test("guides match sibling boundaries through uneven subtree depths", () => {
    // Deterministic shapes exercise depth increases, decreases and separate
    // roots. The simple forward oracle specifies visible tree continuity.
    let seed = 17;
    for (let shape = 0; shape < 100; shape++) {
      const rows = [row("root", 0)];
      let depth = 0;
      for (let i = 0; i < 40; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        depth = seed % Math.min(8, depth + 2);
        rows.push(row(String(i), depth));
      }
      const oracle = rows.map((entry, index) => {
        let guide = "";
        for (let d = 1; d <= entry.depth; d++) {
          let hasSibling = false;
          for (let next = index + 1; next < rows.length; next++) {
            if (rows[next]!.depth < d) break;
            if (rows[next]!.depth === d) {
              hasSibling = true;
              break;
            }
          }
          guide += d === entry.depth ? (hasSibling ? "├─" : "└─") : hasSibling ? "│ " : "  ";
        }
        return guide;
      });
      expect(buildTreeGuides(rows)).toEqual(oracle);
    }
  });

  test("top-level rows carry no guide", () => {
    expect(buildTreeGuides([row("a", 0), row("b", 0)])).toEqual(["", ""]);
  });

  test("last child at a depth gets a corner, earlier ones get a tee", () => {
    const rows = [row("a", 0), row("a/x", 1), row("a/y", 1)];
    expect(buildTreeGuides(rows)).toEqual(["", "├─", "└─"]);
  });

  test("a following row at a shallower depth does not keep a guide alive", () => {
    // `a/y` is the last child of `a` even though `b` follows at depth 0.
    const rows = [row("a", 0), row("a/x", 1), row("a/y", 1), row("b", 0)];
    expect(buildTreeGuides(rows)).toEqual(["", "├─", "└─", ""]);
  });

  test("trunk continues through nested levels while the ancestor has siblings", () => {
    const rows = [row("a", 0), row("a/x", 1), row("a/x/1", 2), row("a/x/2", 2), row("a/y", 1)];
    expect(buildTreeGuides(rows)).toEqual(["", "├─", "│ ├─", "│ └─", "└─"]);
  });

  test("trunk goes blank once the ancestor has no siblings left", () => {
    const rows = [row("a", 0), row("a/y", 1), row("a/y/1", 2), row("a/y/2", 2)];
    expect(buildTreeGuides(rows)).toEqual(["", "└─", "  ├─", "  └─"]);
  });

  test("every guide is two columns per depth level so labels stay aligned", () => {
    const rows = [row("a", 0), row("a/x", 1), row("a/x/1", 2), row("a/x/1/i", 3)];
    for (const [index, guide] of buildTreeGuides(rows).entries()) {
      expect(guide.length).toBe((rows[index]?.depth ?? 0) * 2);
    }
  });
});

describe("ancestorKeysOf", () => {
  test("returns every folder on the path, including the scope itself", () => {
    expect(ancestorKeysOf("apps/cli/nested")).toEqual(["apps", "apps/cli", "apps/cli/nested"]);
  });

  test("all-scopes and the project root have no ancestors to open", () => {
    expect(ancestorKeysOf(null)).toEqual([]);
    expect(ancestorKeysOf("")).toEqual([]);
  });
});
