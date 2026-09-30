import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clean, deduplicateNestedEntries } from "./cleaner.js";
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

  test("removes exact-path duplicates (e.g. a crafted plan with repeated paths)", () => {
    const entry: ScanEntry = {
      path: join(root, "node_modules"),
      name: "node_modules",
      estimatedBytes: 1000,
      isSymlink: false,
      entryType: "directory",
    };
    const deduplicated = deduplicateNestedEntries([entry, { ...entry }, { ...entry }]);
    expect(deduplicated.length).toBe(1);
  });
});

describe("clean with trashDir", () => {
  test("moves entries into the trash dir preserving target-relative paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-trash-test-"));
    try {
      const targetDir = join(root, "project");
      mkdirSync(join(targetDir, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(targetDir, "apps", "web", "dist"), { recursive: true });
      writeFileSync(join(targetDir, "node_modules", "pkg", "index.js"), "x");
      writeFileSync(join(targetDir, "apps", "web", "dist", "bundle.js"), "y");

      const entries: ScanEntry[] = [
        {
          path: join(targetDir, "node_modules"),
          name: "node_modules",
          estimatedBytes: 1,
          isSymlink: false,
          entryType: "directory",
        },
        {
          path: join(targetDir, "apps", "web", "dist"),
          name: "dist",
          estimatedBytes: 1,
          isSymlink: false,
          entryType: "directory",
        },
      ];

      const trashDir = join(targetDir, ".sweep-trash-2025-01-01");
      const result = await clean(entries, { trashDir, trashRoot: targetDir });

      expect(result.failedPaths).toEqual([]);
      expect(result.deleted.length).toBe(2);
      expect(existsSync(join(targetDir, "node_modules"))).toBe(false);
      expect(existsSync(join(targetDir, "apps", "web", "dist"))).toBe(false);
      // Restorable layout mirrors the original tree.
      expect(readFileSync(join(trashDir, "node_modules", "pkg", "index.js"), "utf-8")).toBe("x");
      expect(readFileSync(join(trashDir, "apps", "web", "dist", "bundle.js"), "utf-8")).toBe("y");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("moves a symlink itself into trash without touching its target", async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-trash-link-"));
    try {
      const targetDir = join(root, "project");
      const outside = join(root, "outside");
      mkdirSync(targetDir, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "keep.txt"), "keep");
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outside, join(targetDir, "link-out"));

      const entries: ScanEntry[] = [
        {
          path: join(targetDir, "link-out"),
          name: "link-out",
          estimatedBytes: 0,
          isSymlink: true,
          entryType: "directory",
        },
      ];

      const trashDir = join(targetDir, ".sweep-trash-2025-01-01");
      const result = await clean(entries, { trashDir, trashRoot: targetDir });

      expect(result.failedPaths).toEqual([]);
      expect(existsSync(join(targetDir, "link-out"))).toBe(false);
      expect(existsSync(join(trashDir, "link-out"))).toBe(true);
      // The target was never touched.
      expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("keep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses to move when a symlink inside the trash layout redirects outside", async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-trash-escape-"));
    try {
      const targetDir = join(root, "project");
      const outside = join(root, "outside");
      mkdirSync(join(targetDir, "apps", "web", "node_modules"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(targetDir, "apps", "web", "node_modules", "index.js"), "x");

      // Attacker (or a raced earlier run) planted trashDir/apps -> outside.
      const trashDir = join(targetDir, ".sweep-trash-2025-01-01");
      mkdirSync(trashDir, { recursive: true });
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outside, join(trashDir, "apps"));

      const entries: ScanEntry[] = [
        {
          path: join(targetDir, "apps", "web", "node_modules"),
          name: "node_modules",
          estimatedBytes: 1,
          isSymlink: false,
          entryType: "directory",
        },
      ];

      const result = await clean(entries, { trashDir, trashRoot: targetDir });

      // The move is refused and the source is left in place - nothing escaped.
      expect(result.deleted.length).toBe(0);
      expect(result.failedPaths.length).toBe(1);
      expect(existsSync(join(targetDir, "apps", "web", "node_modules", "index.js"))).toBe(true);
      // mkdir may create the empty "web" dir via the symlink; the artifact
      // itself must never land outside the trash root.
      expect(existsSync(join(outside, "web", "node_modules"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
