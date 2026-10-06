import { describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clean, deduplicateNestedEntries } from "./cleaner.js";
import type { ScanEntry } from "@kitsunekode/sweep-protocol";

test.skipIf(process.platform === "win32")(
  "literal POSIX trash paths move or remain untouched when runtime canonicalization fails",
  async () => {
    const owned = mkdtempSync(join(tmpdir(), "sweep-trash-literal-names-"));
    try {
      const target = join(owned, "project");
      const trashDir = join(target, ".sweep-trash-test");
      const entries: ScanEntry[] = [];
      for (const parent of ["..\\x", "a\\b"]) {
        const path = join(target, parent, "node_modules");
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "keep"), parent);
        entries.push({
          path,
          name: "node_modules",
          estimatedBytes: 1,
          entryType: "directory",
          isSymlink: false,
        });
      }
      let canonicalizationWorks = true;
      try {
        realpathSync(join(target, "a\\b"));
      } catch {
        canonicalizationWorks = false;
      }
      // Production apply always supplies containment. Without it, macOS
      // trash moves need not canonicalize these literal parent names.
      const result = await clean(entries, {
        containmentRoot: target,
        trashDir,
        trashRoot: target,
      });
      if (!canonicalizationWorks) {
        expect(result.deleted).toHaveLength(0);
        expect(result.failedPaths).toHaveLength(2);
        for (const entry of entries)
          expect(readFileSync(join(entry.path, "keep"), "utf8")).toBeTruthy();
        return;
      }
      expect(result.failedPaths).toEqual([]);
      expect(result.deleted).toHaveLength(2);
      for (const parent of ["..\\x", "a\\b"]) {
        expect(readFileSync(join(trashDir, parent, "node_modules", "keep"), "utf8")).toBe(parent);
      }
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  },
);

test("trash receipts identify the actual collision-free payload destination", async () => {
  const owned = mkdtempSync(join(tmpdir(), "sweep-trash-receipt-"));
  try {
    const artifact = join(owned, "node_modules");
    const trash = join(owned, ".sweep-trash-test");
    mkdirSync(artifact);
    mkdirSync(trash);
    writeFileSync(join(artifact, "keep"), "payload");
    mkdirSync(join(trash, "node_modules"));
    writeFileSync(join(trash, "node_modules", "keep"), "previous");
    const result = await clean(
      [
        {
          path: artifact,
          name: "node_modules",
          entryType: "directory",
          isSymlink: false,
          estimatedBytes: 7,
        },
      ],
      {
        containmentRoot: owned,
        trashDir: trash,
        trashRoot: owned,
      },
    );
    const destination =
      process.platform === "win32"
        ? join(trash, "node_modules-2", "payload")
        : join(trash, "node_modules-2");
    expect(result.trashMoves).toEqual([{ path: artifact, destination }]);
    expect(readFileSync(join(destination, "keep"), "utf8")).toBe("payload");
    expect(readFileSync(join(trash, "node_modules", "keep"), "utf8")).toBe("previous");
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
});

test("recursive deletion preserves the contents of an external hardlink", async () => {
  const owned = mkdtempSync(join(tmpdir(), "sweep-interior-hardlink-"));
  try {
    const root = join(owned, "project");
    const artifact = join(root, "node_modules");
    const external = join(owned, "keep");
    mkdirSync(artifact, { recursive: true });
    writeFileSync(external, "keep");
    linkSync(external, join(artifact, "linked"));
    const result = await clean(
      [
        {
          path: artifact,
          name: "node_modules",
          entryType: "directory",
          isSymlink: false,
          estimatedBytes: 4,
        },
      ],
      { containmentRoot: root },
    );
    expect(result.deleted).toHaveLength(1);
    expect(result.failedPaths).toHaveLength(0);
    expect(readFileSync(external, "utf8")).toBe("keep");
    expect(existsSync(artifact)).toBe(false);
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "recursive deletion preserves interior symlink targets",
  async () => {
    const owned = mkdtempSync(join(tmpdir(), "sweep-interior-links-"));
    try {
      const root = join(owned, "project");
      const artifact = join(root, "node_modules");
      const external = join(owned, "external");
      mkdirSync(artifact, { recursive: true });
      mkdirSync(external);
      writeFileSync(join(external, "keep"), "keep");
      symlinkSync(external, join(artifact, "linked-dir"));
      symlinkSync(join(external, "keep"), join(artifact, "linked-file"));
      const result = await clean(
        [
          {
            path: artifact,
            name: "node_modules",
            entryType: "directory",
            isSymlink: false,
            estimatedBytes: 0,
          },
        ],
        { containmentRoot: root },
      );
      expect(result.deleted).toHaveLength(1);
      expect(result.failedPaths).toHaveLength(0);
      expect(readFileSync(join(external, "keep"), "utf8")).toBe("keep");
      expect(existsSync(artifact)).toBe(false);
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  },
);

test("cancellation in onBegin preserves the entry for delete and trash", async () => {
  for (const trash of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "sweep-begin-cancel-"));
    try {
      const path = join(root, "node_modules");
      mkdirSync(path);
      let cancelled = false;
      let progressed = 0;
      const result = await clean(
        [
          {
            path,
            name: "node_modules",
            estimatedBytes: 0,
            entryType: "directory",
            isSymlink: false,
          },
        ],
        {
          containmentRoot: root,
          ...(trash ? { trashDir: join(root, "trash"), trashRoot: root } : {}),
          isCancelled: () => cancelled,
          onBegin: () => {
            cancelled = true;
          },
          onProgress: () => {
            progressed++;
          },
        },
      );
      expect(result.deleted).toHaveLength(0);
      expect(result.failedPaths).toHaveLength(0);
      expect(progressed).toBe(0);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a same-type replacement in onBegin is preserved for delete and trash", async () => {
  for (const trash of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "sweep-begin-replace-"));
    try {
      const path = join(root, "node_modules");
      const original = join(root, "original");
      mkdirSync(path);
      const result = await clean(
        [
          {
            path,
            name: "node_modules",
            estimatedBytes: 0,
            entryType: "directory",
            isSymlink: false,
          },
        ],
        {
          containmentRoot: root,
          ...(trash ? { trashDir: join(root, "trash"), trashRoot: root } : {}),
          onBegin: () => {
            renameSync(path, original);
            mkdirSync(path);
            writeFileSync(join(path, "keep"), "replacement");
          },
        },
      );
      expect(result.deleted).toHaveLength(0);
      expect(result.failedPaths).toHaveLength(1);
      expect(readFileSync(join(path, "keep"), "utf8")).toBe("replacement");
      expect(existsSync(original)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

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
  test("a trash root recreated at the same path is refused", async () => {
    const owned = mkdtempSync(join(tmpdir(), "sweep-trash-root-replace-"));
    try {
      const root = join(owned, "project");
      const path = join(root, "node_modules");
      const trashDir = join(owned, "trash");
      const originalTrash = join(owned, "original-trash");
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "keep"), "source");
      const result = await clean(
        [
          {
            path,
            name: "node_modules",
            entryType: "directory",
            isSymlink: false,
            estimatedBytes: 6,
          },
        ],
        {
          containmentRoot: root,
          trashRoot: root,
          trashDir,
          onBegin: () => {
            renameSync(trashDir, originalTrash);
            mkdirSync(trashDir);
            writeFileSync(join(trashDir, "sentinel"), "replacement");
          },
        },
      );
      expect(result.deleted).toHaveLength(0);
      expect(result.failedPaths).toHaveLength(1);
      expect(result.failedPaths[0]?.error).toContain("changed during apply");
      expect(readFileSync(join(path, "keep"), "utf8")).toBe("source");
      expect(readFileSync(join(trashDir, "sentinel"), "utf8")).toBe("replacement");
      expect(existsSync(join(trashDir, "node_modules"))).toBe(false);
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  });

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
      expect(
        readFileSync(
          join(
            trashDir,
            "node_modules",
            ...(process.platform === "win32" ? ["payload"] : []),
            "pkg",
            "index.js",
          ),
          "utf-8",
        ),
      ).toBe("x");
      expect(
        readFileSync(
          join(
            trashDir,
            "apps",
            "web",
            "dist",
            ...(process.platform === "win32" ? ["payload"] : []),
            "bundle.js",
          ),
          "utf-8",
        ),
      ).toBe("y");
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
      expect(
        readFileSync(
          join(
            trashDir,
            "node_modules-2",
            ...(process.platform === "win32" ? ["payload"] : []),
            "index.js",
          ),
          "utf-8",
        ),
      ).toBe("new");
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
