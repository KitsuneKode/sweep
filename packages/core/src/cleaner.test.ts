import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deduplicateNestedEntries } from "./cleaner.js";
import type { ScanEntry } from "@kitsunekode/sweep-protocol";

describe("deduplicateNestedEntries", () => {
  const root = join(tmpdir(), "sweep-cleaner-test");

  test("removes child candidates when parent directory candidate is present", () => {
    const entries: ScanEntry[] = [
      {
        path: join(root, "dist"),
        name: "dist",
        estimatedBytes: 1000,
        isSymlink: false,
        entryType: "directory",
      },
      {
        path: join(root, "dist", "sub-bundle"),
        name: "sub-bundle",
        estimatedBytes: 400,
        isSymlink: false,
        entryType: "directory",
      },
      {
        path: join(root, "node_modules"),
        name: "node_modules",
        estimatedBytes: 5000,
        isSymlink: false,
        entryType: "directory",
      },
    ];

    const deduplicated = deduplicateNestedEntries(entries);
    expect(deduplicated.length).toBe(2);
    expect(deduplicated.map((e) => e.path)).toEqual([
      join(root, "dist"),
      join(root, "node_modules"),
    ]);
  });

  test("does not filter peer directories", () => {
    const entries: ScanEntry[] = [
      {
        path: join(root, "apps", "web", "node_modules"),
        name: "node_modules",
        estimatedBytes: 1000,
        isSymlink: false,
        entryType: "directory",
      },
      {
        path: join(root, "apps", "api", "node_modules"),
        name: "node_modules",
        estimatedBytes: 1000,
        isSymlink: false,
        entryType: "directory",
      },
    ];

    const deduplicated = deduplicateNestedEntries(entries);
    expect(deduplicated.length).toBe(2);
  });

  test("handles lexicographically sorted parent-child pairs regardless of length", () => {
    const entries: ScanEntry[] = [
      {
        path: join(root, "a", "nested", "deep", "dir"),
        name: "dir",
        estimatedBytes: 200,
        isSymlink: false,
        entryType: "directory",
      },
      {
        path: join(root, "a"),
        name: "a",
        estimatedBytes: 2000,
        isSymlink: false,
        entryType: "directory",
      },
      {
        path: join(root, "z-long-sibling-name"),
        name: "z-long-sibling-name",
        estimatedBytes: 500,
        isSymlink: false,
        entryType: "directory",
      },
    ];

    const deduplicated = deduplicateNestedEntries(entries);
    expect(deduplicated.length).toBe(2);
    expect(deduplicated.map((e) => e.path)).toEqual([
      join(root, "a"),
      join(root, "z-long-sibling-name"),
    ]);
  });

  test("does not deduplicate inside symlink directories", () => {
    const entries: ScanEntry[] = [
      {
        path: join(root, "symlink-dir"),
        name: "symlink-dir",
        estimatedBytes: 0,
        isSymlink: true,
        entryType: "symlink",
      },
      {
        path: join(root, "symlink-dir", "child"),
        name: "child",
        estimatedBytes: 100,
        isSymlink: false,
        entryType: "file",
      },
    ];

    const deduplicated = deduplicateNestedEntries(entries);
    // Symlinks are not deleted recursively by parent, so child should not be filtered out
    expect(deduplicated.length).toBe(2);
  });
});
