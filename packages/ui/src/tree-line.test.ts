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
