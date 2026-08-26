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
});
