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

describe("clean", () => {
  test("a vanished entry reports missing instead of a phantom delete", async () => {
    // rm(force: true) never complains about a missing path, so without the
    // pre-delete lstat a raced-away entry would land in `deleted`.
    const root = mkdtempSync(join(tmpdir(), "sweep-clean-missing-"));
    try {
      const result = await clean([
        {
          path: join(root, "ghost"),
          name: "ghost",
          estimatedBytes: 0,
          isSymlink: false,
          entryType: "directory",
        },
      ]);

      expect(result.deleted).toHaveLength(0);
      expect(result.failedPaths).toHaveLength(1);
      expect(result.failedPaths[0]?.code).toBe("missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("trashDir without trashRoot is rejected up front", async () => {
    // The pairing is the containment contract - one without the other means
    // "move things somewhere undefined", which must throw, not best-guess.
    await expect(clean([], { trashDir: "/tmp/sweep-unpaired" })).rejects.toThrow(/together/);
    await expect(clean([], { trashRoot: "/tmp/sweep-unpaired" })).rejects.toThrow(/together/);
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
          // Plans carry entryType "symlink" for link entries - the scanner
          // emits it and revalidate enforces it (planner.ts).
          entryType: "symlink",
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

  test("never clobbers an existing trash destination - bumps a suffix", async () => {
    // POSIX rename silently replaces an existing destination: a leftover from
    // an earlier trash run (or a case-variant duplicate) sitting at the same
    // rel path must survive alongside the new move.
    const root = mkdtempSync(join(tmpdir(), "sweep-trash-collide-"));
    try {
      const targetDir = join(root, "project");
      mkdirSync(join(targetDir, "node_modules"), { recursive: true });
      writeFileSync(join(targetDir, "node_modules", "index.js"), "new");

      const trashDir = join(targetDir, ".sweep-trash-2025-01-01");
      mkdirSync(join(trashDir, "node_modules"), { recursive: true });
      writeFileSync(join(trashDir, "node_modules", "index.js"), "prior");

      const result = await clean(
        [
          {
            path: join(targetDir, "node_modules"),
            name: "node_modules",
            estimatedBytes: 1,
            isSymlink: false,
            entryType: "directory",
          },
        ],
        { trashDir, trashRoot: targetDir },
      );

      expect(result.failedPaths).toEqual([]);
      expect(result.deleted.length).toBe(1);
      // Prior trash contents survive; the new move lands under a bumped name.
      expect(readFileSync(join(trashDir, "node_modules", "index.js"), "utf-8")).toBe("prior");
      expect(readFileSync(join(trashDir, "node_modules-2", "index.js"), "utf-8")).toBe("new");
      expect(existsSync(join(targetDir, "node_modules"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("clean delete-time hardening", () => {
  test("an unresolvable containment root fails every entry closed", async () => {
    // A dangling-then-repointed target must not turn "couldn't canonicalize"
    // into "no canonical checks at all" - every entry fails outside_target.
    const root = mkdtempSync(join(tmpdir(), "sweep-rootgone-"));
    try {
      const targetDir = join(root, "project");
      mkdirSync(join(targetDir, "node_modules"), { recursive: true });
      writeFileSync(join(targetDir, "node_modules", "index.js"), "x");

      const result = await clean(
        [
          {
            path: join(targetDir, "node_modules"),
            name: "node_modules",
            estimatedBytes: 1,
            isSymlink: false,
            entryType: "directory",
          },
        ],
        { containmentRoot: join(root, "does-not-exist") },
      );

      expect(result.deleted.length).toBe(0);
      expect(result.failedPaths[0]?.code).toBe("outside_target");
      expect(existsSync(join(targetDir, "node_modules", "index.js"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a trashDir swapped for a symlink mid-apply cannot redirect moves", async () => {
    // The pin is taken once in clean(); re-resolving the trash root per move
    // would follow the swap and tautologically "pass" containment.
    const root = mkdtempSync(join(tmpdir(), "sweep-trashpin-"));
    try {
      const targetDir = join(root, "project");
      const outside = join(root, "outside");
      mkdirSync(join(targetDir, "node_modules"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(targetDir, "node_modules", "index.js"), "x");

      const trashDir = join(targetDir, ".sweep-trash-2025-01-01");
      mkdirSync(trashDir, { recursive: true });
      const { symlinkSync } = await import("node:fs");
      let swapped = false;

      const result = await clean(
        [
          {
            path: join(targetDir, "node_modules"),
            name: "node_modules",
            estimatedBytes: 1,
            isSymlink: false,
            entryType: "directory",
          },
        ],
        {
          trashDir,
          trashRoot: targetDir,
          onBegin: () => {
            // Swap lands after clean() pinned the real trash dir.
            rmSync(trashDir, { recursive: true, force: true });
            symlinkSync(outside, trashDir);
            swapped = true;
          },
        },
      );

      expect(swapped).toBe(true);
      expect(result.deleted.length).toBe(0);
      expect(result.failedPaths.length).toBe(1);
      // Nothing left the target: source intact, nothing relocated outside.
      expect(existsSync(join(targetDir, "node_modules", "index.js"))).toBe(true);
      expect(existsSync(join(outside, "node_modules"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("onProgress reports succeeded=false for failed entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-progress-"));
    try {
      const targetDir = join(root, "project");
      mkdirSync(join(targetDir, "node_modules"), { recursive: true });
      writeFileSync(join(targetDir, "node_modules", "index.js"), "x");
      const gone = join(targetDir, "dist");

      const outcomes = new Map<string, boolean>();
      await clean(
        [
          {
            path: join(targetDir, "node_modules"),
            name: "node_modules",
            estimatedBytes: 1,
            isSymlink: false,
            entryType: "directory",
          },
          {
            path: gone,
            name: "dist",
            estimatedBytes: 5,
            isSymlink: false,
            entryType: "directory",
          },
        ],
        {
          onProgress: (entry, _i, _total, succeeded) => {
            outcomes.set(entry.path, succeeded);
          },
        },
      );

      expect(outcomes.get(join(targetDir, "node_modules"))).toBe(true);
      // Failed entries must not paint as freed bytes downstream.
      expect(outcomes.get(gone)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
