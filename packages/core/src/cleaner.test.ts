import { describe, expect, test } from "bun:test";
import { deduplicateNestedEntries } from "./cleaner.js";
import type { ScanEntry } from "@kitsunekode/sweep-protocol";

describe("deduplicateNestedEntries", () => {
  test("removes child candidates when parent directory candidate is present", () => {
    const entries: ScanEntry[] = [
      {
        path: "/tmp/project/dist",
        name: "dist",
        estimatedBytes: 1000,
        isSymlink: false,
        entryType: "directory",
      },
      {
        path: "/tmp/project/dist/sub-bundle",
        name: "sub-bundle",
        estimatedBytes: 400,
        isSymlink: false,
        entryType: "directory",
      },
      {
        path: "/tmp/project/node_modules",
        name: "node_modules",
        estimatedBytes: 5000,
        isSymlink: false,
        entryType: "directory",
      },
    ];

    const deduplicated = deduplicateNestedEntries(entries);
    expect(deduplicated.length).toBe(2);
    expect(deduplicated.map((e) => e.path)).toEqual([
      "/tmp/project/dist",
      "/tmp/project/node_modules",
    ]);
  });

  test("does not filter peer directories", () => {
    const entries: ScanEntry[] = [
      {
        path: "/tmp/project/apps/web/node_modules",
        name: "node_modules",
        estimatedBytes: 1000,
        isSymlink: false,
        entryType: "directory",
      },
      {
        path: "/tmp/project/apps/api/node_modules",
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
