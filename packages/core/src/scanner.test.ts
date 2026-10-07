import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "./config.js";
import { stubDirectoryEntriesForTest } from "./directory-reader.js";
import { ResourceBudget } from "./resource-budget.js";
import {
  exactSizeAsync,
  exactSizeDetailed,
  apparentSizeDetailed,
  scan,
  ProgressiveSizer,
} from "./scanner.js";
import type { SweepConfig } from "@kitsunekode/sweep-protocol";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

function safeSymlink(target: string, path: string, type: "file" | "dir" = "dir"): void {
  try {
    symlinkSync(target, path, type);
  } catch {
    if (type === "dir" && process.platform === "win32") {
      try {
        symlinkSync(target, path, "junction");
      } catch {
        // ignore if unprivileged on Windows
      }
    }
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sweep-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const dir = (...parts: string[]) => join(tmpDir, ...parts);

test.skipIf(process.platform !== "linux")(
  "discovery never aliases invalid UTF-8 bytes to a real replacement-character name",
  async () => {
    const invalid = Buffer.concat([
      Buffer.from(`${tmpDir}/`),
      Buffer.from([0xff]),
      Buffer.from(".tmp"),
    ]);
    writeFileSync(invalid, "invalid");
    const valid = dir("\ufffd.tmp");
    writeFileSync(valid, "valid");
    const revealed: string[] = [];
    const result = await scan(tmpDir, { ...DEFAULT_CONFIG, patterns: ["*.tmp"] }, false, {
      onEntry: (entry) => revealed.push(entry.path),
    });
    expect(result.entries.map((entry) => entry.path)).toEqual([valid]);
    expect(revealed).toEqual([valid]);
    expect(result.skippedDirs).toBe(1);
  },
);

test("resource exhaustion rejects without presenting a partial scan as complete", async () => {
  mkdirSync(dir("node_modules"));
  mkdirSync(dir("dist"));
  let discovered = 0;
  await expect(
    scan(tmpDir, { ...DEFAULT_CONFIG, patterns: ["node_modules", "dist"] }, false, {
      limits: { maxCandidates: 1 },
      onEntry: () => discovered++,
    }),
  ).rejects.toThrow("maxCandidates");
  expect(discovered).toBe(1);
});

test("scan charges the plan's retained metadata before revealing a candidate", async () => {
  mkdirSync(dir("node_modules"));
  let discovered = 0;
  // Root path + root identity + candidate path/object, but insufficient
  // room for its ID, name, kind, identity and classification reasons.
  const pathOnly =
    128 + Buffer.byteLength(tmpDir) * 4 + 128 + 1024 + Buffer.byteLength(dir("node_modules")) * 4;
  stubDirectoryEntriesForTest(async function* (path) {
    if (String(path) === tmpDir) yield { name: Buffer.from("node_modules"), type: "d" };
  });
  try {
    await expect(
      scan(tmpDir, DEFAULT_CONFIG, false, {
        limits: { maxRetainedBytes: pathOnly + 16 },
        onEntry: () => discovered++,
      }),
    ).rejects.toThrow("maxRetainedBytes");
    expect(discovered).toBe(0);
  } finally {
    stubDirectoryEntriesForTest();
  }
});

test("sizing bounds itself per-job, not against the walk admission budget", async () => {
  mkdirSync(dir("node_modules", "nested"), { recursive: true });
  writeFileSync(dir("node_modules", "nested", "file"), "hello");
  for (const exact of [false, true]) {
    // A tight walk-level cap must not bleed into sizing: a candidate's own
    // subtree was already admitted when it matched, and sizing re-walks it
    // under transient per-job caps, not cumulative scan counters.
    const result = await scan(tmpDir, DEFAULT_CONFIG, exact, {
      limits: { maxDirectories: 2 },
    });
    expect(result.entries.length).toBe(1);
  }
});

test("a large flat directory is enumerated incrementally with bounded metadata batches", async () => {
  // Keep the wide fixture on the checkout filesystem: /tmp may have a small
  // per-user quota even when statvfs reports plenty of global capacity.
  rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = mkdtempSync(join(import.meta.dir, "../../../.plans/sweep-flat-test-"));
  mkdirSync(dir("node_modules"));
  for (let i = 0; i < 4096; i++) writeFileSync(dir("node_modules", `${i}`), "x");
  const result = await scan(tmpDir, DEFAULT_CONFIG, true, { limits: { maxQueuedDirs: 2 } });
  expect(result.estimatedTotalBytes).toBe(4096);
  expect(result.exact).toBe(true);
});

test("a budget failure drains workers and allows a later scan", async () => {
  for (let i = 0; i < 64; i++) mkdirSync(dir(`${i}`, "node_modules"), { recursive: true });
  for (let i = 0; i < 3; i++) {
    await expect(
      scan(tmpDir, DEFAULT_CONFIG, true, { limits: { maxDirectories: 2 } }),
    ).rejects.toThrow("maxDirectories");
  }
  expect((await scan(tmpDir, DEFAULT_CONFIG, true)).entries).toHaveLength(64);
});

test("streaming sizing preserves filenames that are not valid UTF-8", async () => {
  if (process.platform !== "linux") return;
  const artifact = dir("node_modules");
  mkdirSync(artifact);
  writeFileSync(Buffer.concat([Buffer.from(`${artifact}/`), Buffer.from([0xff])]), "hello");
  for (const size of [exactSizeDetailed, apparentSizeDetailed])
    expect(await size(artifact)).toEqual({ bytes: 5, complete: true });
});

test("sparse sizing delivers a result while the traversal is still idle", async () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  mkdirSync(dir("node_modules"));
  writeFileSync(dir("node_modules", "file"), "hello");
  let resolveSize!: () => void;
  const delivered = new Promise<void>((resolve) => {
    resolveSize = resolve;
  });
  const sizer = new ProgressiveSizer({ onEntrySized: resolveSize });
  sizer.add({
    path: dir("node_modules"),
    name: "node_modules",
    entryType: "directory",
    isSymlink: false,
    estimatedBytes: 0,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      delivered,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("sparse size was buffered until walk end")),
          750,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    await sizer.finish();
  }
});

test("a traversal hook failure rejects and removes its abort listener", async () => {
  mkdirSync(dir("node_modules"));
  const controller = new AbortController();
  let activeListeners = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args: Parameters<typeof add>) => {
    activeListeners++;
    add(...args);
  };
  controller.signal.removeEventListener = (...args: Parameters<typeof remove>) => {
    activeListeners--;
    remove(...args);
  };
  await expect(
    scan(tmpDir, DEFAULT_CONFIG, true, {
      signal: controller.signal,
      onEntry: () => {
        throw new Error("injected hook failure");
      },
    }),
  ).rejects.toThrow("injected hook failure");
  expect(activeListeners).toBe(0);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("scan: basic matching", () => {
  test("finds node_modules at the root level", async () => {
    mkdirSync(dir("node_modules"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("node_modules");
    expect(result.entries[0]?.path).toBe(dir("node_modules"));
  });

  test("finds multiple matching patterns", async () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir(".turbo"));
    mkdirSync(dir(".next"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(3);
  });

  test("generic names like dist stay out of defaults but are one config away", async () => {
    mkdirSync(dir("dist"));
    mkdirSync(dir("build"));
    // dist/build are opt-in catalog entries - a bare run must not touch them.
    const defaults = await scan(tmpDir, DEFAULT_CONFIG);
    expect(defaults.entries).toHaveLength(0);

    const optedIn = await scan(tmpDir, { ...DEFAULT_CONFIG, patterns: ["dist", "build"] });
    expect(optedIn.entries).toHaveLength(2);
  });

  test("ignores directories that don't match any pattern", async () => {
    mkdirSync(dir("src"));
    mkdirSync(dir("components"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(0);
  });

  test("matches *.tsbuildinfo glob pattern", async () => {
    mkdirSync(dir("packages", "api"), { recursive: true });
    writeFileSync(dir("tsconfig.tsbuildinfo"), "");
    writeFileSync(dir("packages", "api", "tsconfig.tsbuildinfo"), "{}");
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    // Should match both tsbuildinfo files
    expect(result.entries.some((e) => e.name === "tsconfig.tsbuildinfo")).toBe(true);
  });

  test("? is glob single-char, not a regex quantifier", async () => {
    // `foo?` must match `foo1` and NOT `foo`/`fo` - before the fix the raw `?`
    // compiled as a regex quantifier, silently missing or over-matching, and
    // diverged from the Rust engine (which escaped it literally).
    writeFileSync(dir("foo1"), "x");
    writeFileSync(dir("foo"), "x");
    writeFileSync(dir("fo"), "x");
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["foo?"] };
    const result = await scan(tmpDir, config);
    const names = result.entries.map((e) => e.name).sort();
    expect(names).toEqual(["foo1"]);
  });
});

describe("scan: modified time", () => {
  test("reports the artifact's own mtime in epoch milliseconds", async () => {
    mkdirSync(dir("node_modules"));
    const stamp = new Date("2024-03-05T10:20:30.000Z");
    utimesSync(dir("node_modules"), stamp, stamp);

    const result = await scan(tmpDir, DEFAULT_CONFIG);

    expect(result.entries[0]?.modifiedMs).toBe(stamp.getTime());
  });

  test("reports a symlink's own mtime, not its target's", async () => {
    mkdirSync(dir("real"));
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(dir("real"), old, old);
    safeSymlink(dir("real"), dir("node_modules"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    const link = result.entries.find((entry) => entry.name === "node_modules");
    if (!link?.isSymlink) return; // unprivileged Windows: symlink could not be created
    expect(link.modifiedMs).toBeGreaterThan(old.getTime());
  });
});

describe("scan: recursion", () => {
  test("finds node_modules recursively in a monorepo", async () => {
    mkdirSync(dir("packages", "web"), { recursive: true });
    mkdirSync(dir("packages", "api"), { recursive: true });
    mkdirSync(dir("packages", "web", "node_modules"));
    mkdirSync(dir("packages", "api", "node_modules"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(2);
  });

  test("does NOT recurse into a matched directory (no double-counting)", async () => {
    // node_modules containing a nested node_modules should only be counted once
    mkdirSync(dir("node_modules", "some-pkg", "node_modules"), { recursive: true });
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("node_modules");
  });

  test("respects depth: 0 (only root level)", async () => {
    mkdirSync(dir("a", "node_modules"), { recursive: true });
    mkdirSync(dir("node_modules")); // root level, should be found at depth 0
    const config: SweepConfig = { ...DEFAULT_CONFIG, depth: 0 };
    const result = await scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toBe(dir("node_modules"));
  });

  test("respects depth: 1 (one level deep)", async () => {
    mkdirSync(dir("a", "b", "node_modules"), { recursive: true }); // depth 2, excluded
    mkdirSync(dir("a", "node_modules"), { recursive: true }); // depth 1, included
    const config: SweepConfig = { ...DEFAULT_CONFIG, depth: 1 };
    const result = await scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toBe(dir("a", "node_modules"));
  });
});

describe("scan: symlinks", () => {
  test("marks symlinks as isSymlink: true", async () => {
    mkdirSync(dir("real-dir"));
    safeSymlink(dir("real-dir"), dir("node_modules"), "dir");
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.isSymlink).toBe(true);
  });

  test("does NOT recurse into symlinked directories", async () => {
    mkdirSync(dir("real-dir", "node_modules"), { recursive: true });
    safeSymlink(dir("real-dir"), dir("linked"), "dir");
    // Should find: linked/ (symlink) but NOT recurse into real-dir/node_modules via linked/
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["linked"] };
    const result = await scan(tmpDir, config);
    // real-dir/node_modules might be found, but linked/ itself should not be recursed
    expect(result.entries.every((e) => e.name !== "linked" || e.isSymlink)).toBe(true);
  });
});

describe("scan: ignore rules", () => {
  test("skips entries matching ignore list", async () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));
    const config: SweepConfig = { ...DEFAULT_CONFIG, ignore: ["dist"] };
    const result = await scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("node_modules");
  });

  test("ignore matches full path (substring match)", async () => {
    mkdirSync(dir("packages", "vendor", "node_modules"), { recursive: true });
    mkdirSync(dir("packages", "web", "node_modules"), { recursive: true });
    const config: SweepConfig = { ...DEFAULT_CONFIG, ignore: ["packages/vendor"] };
    const result = await scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toContain(join("packages", "web"));
  });

  test("ignore matches basename globs", async () => {
    mkdirSync(dir("foo.cache"));
    mkdirSync(dir("node_modules"));
    const config: SweepConfig = {
      ...DEFAULT_CONFIG,
      patterns: ["node_modules", "*.cache"],
      ignore: ["*.cache"],
    };
    const result = await scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("node_modules");
  });
});

describe("scan: adversarial / security", () => {
  test("handles directory names with shell metacharacters safely", async () => {
    // If size estimation used execSync with string interpolation, this would be exploitable.
    // Windows NTFS forbids semicolon and redirection operators in filenames.
    if (process.platform === "win32") return;
    const dangerous = dir("dist;echo PWNED>/tmp/sweep-pwned-$RANDOM");
    mkdirSync(dangerous, { recursive: true });
    const config: SweepConfig = {
      ...DEFAULT_CONFIG,
      patterns: ["dist;echo PWNED>/tmp/sweep-pwned-$RANDOM"],
    };
    // Should complete without throwing or executing the injected command
    await scan(tmpDir, config);
  });

  test("handles directory names with backticks safely", async () => {
    const dangerous = dir("node_modules`id`");
    mkdirSync(dangerous);
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["node_modules`id`"] };
    await scan(tmpDir, config);
  });

  test("handles directory names with dollar signs safely", async () => {
    const dangerous = dir("dist$(whoami)");
    mkdirSync(dangerous);
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["dist$(whoami)"] };
    await scan(tmpDir, config);
  });

  test("handles directory names with spaces safely", async () => {
    mkdirSync(dir("my project", "node_modules"), { recursive: true });
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("node_modules");
  });

  test("handles directory names with newlines safely", async () => {
    // Windows NTFS forbids newlines in filenames
    if (process.platform === "win32") return;
    const dangerous = dir("node_modules\nnewline");
    mkdirSync(dangerous, { recursive: true });
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["node_modules\nnewline"] };
    await scan(tmpDir, config);
  });

  test("does not follow symlinks pointing outside project root", async () => {
    // A symlink pointing to external root should not be recursed into
    const externalRoot = process.platform === "win32" ? homedir() : "/etc";
    safeSymlink(externalRoot, dir("symlink-to-external"), "dir");
    const config: SweepConfig = { ...DEFAULT_CONFIG, patterns: ["passwd", "nonexistent-artifact"] };
    const result = await scan(tmpDir, config);
    expect(result.entries).toHaveLength(0);
  });

  test("handles circular symlinks without infinite loop", async () => {
    // A → B → A circular symlink chain should terminate
    mkdirSync(dir("a"));
    safeSymlink(dir("a"), dir("b"), "dir");
    // scan should complete in finite time without stack overflow
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.scannedDirs).toBeGreaterThanOrEqual(0);
  });

  test("throws for a root directory that cannot be read", async () => {
    // An unreadable root must surface as a scan failure - silently returning
    // an empty result tells the user "nothing to clean" when the truth is
    // "nothing could be read".
    await expect(
      scan(join(tmpdir(), "sweep-nonexistent-dir-xyz-123"), DEFAULT_CONFIG),
    ).rejects.toThrow();
  });

  test("ignore rule prevents traversal via substring match on injected patterns", async () => {
    mkdirSync(dir("packages", "evil", "node_modules"), { recursive: true });
    mkdirSync(dir("packages", "safe", "node_modules"), { recursive: true });
    // Ignore an adversarial path substring
    const config: SweepConfig = { ...DEFAULT_CONFIG, ignore: ["packages/evil"] };
    const result = await scan(tmpDir, config);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toContain("safe");
  });
});

describe("scan: streaming hooks", () => {
  test("onEntry fires during walk before onEntrySized", async () => {
    mkdirSync(dir("node_modules"));
    const order: string[] = [];

    await scan(tmpDir, DEFAULT_CONFIG, false, {
      onEntry: () => order.push("entry"),
      onEntrySized: () => order.push("sized"),
    });

    expect(order.length).toBeGreaterThan(0);
    expect(order.indexOf("entry")).toBeLessThan(order.indexOf("sized"));
  });

  test("onProgress reports dirs walked during the scan", async () => {
    mkdirSync(dir("a"));
    mkdirSync(dir("b"));
    const reports: Array<{ scannedDirs: number; found: number }> = [];
    const result = await scan(tmpDir, DEFAULT_CONFIG, false, {
      onProgress: (info) => reports.push(info),
    });
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[reports.length - 1]?.scannedDirs).toBe(result.scannedDirs);
  });

  test("onProgress carries sizedCount so hosts can meter real progress", async () => {
    mkdirSync(dir("node_modules"));
    writeFileSync(dir("node_modules/f.bin"), Buffer.alloc(64));
    mkdirSync(dir("dist"));
    const reports: Array<{ sizedCount?: number; found: number }> = [];
    await scan(tmpDir, { ...DEFAULT_CONFIG, patterns: ["node_modules", "dist"] }, false, {
      onProgress: (info) => reports.push(info),
    });
    const last = reports[reports.length - 1];
    // Every report carries the field and the final one has counted all
    // discovered candidates - a meter reading it reaches 100% only on truth.
    expect(last?.sizedCount).toBe(last?.found);
    expect(last?.sizedCount).toBe(2);
  });
});

describe("scan: result metadata", () => {
  test("counts scanned directories", async () => {
    mkdirSync(dir("a"));
    mkdirSync(dir("b"));
    mkdirSync(dir("c"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.scannedDirs).toBeGreaterThan(0);
  });

  test("estimatedTotalBytes sums entry sizes", async () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    const sum = result.entries.reduce((s, e) => s + e.estimatedBytes, 0);
    expect(result.estimatedTotalBytes).toBe(sum);
  });
});

describe("scanner: size estimation", () => {
  test("exactSize calculates recursive size of a directory excluding symlinks", async () => {
    mkdirSync(dir("node_modules"));
    writeFileSync(dir("node_modules", "file1.txt"), "hello"); // 5 bytes
    writeFileSync(dir("node_modules", "file2.txt"), "world!!"); // 8 bytes
    // nested directory
    mkdirSync(dir("node_modules", "nested"));
    writeFileSync(dir("node_modules", "nested", "file3.txt"), "12345"); // 5 bytes
    // symlink (should be skipped)
    writeFileSync(dir("outside.txt"), "some content");
    symlinkSync(dir("outside.txt"), dir("node_modules", "link.txt"));

    const size = await exactSizeAsync(dir("node_modules"));
    expect(size).toBe(5 + 7 + 5);
    expect(await exactSizeAsync(dir("node_modules"))).toBe(size);
  });

  test("symlink candidates report the link's size, not the target's", async () => {
    // statSync follows the link and would report the target's size - deleting
    // the link frees only the link entry, so the estimate must not inflate.
    if (process.platform === "win32") return;
    mkdirSync(dir("real"));
    writeFileSync(dir("real", "big.bin"), Buffer.alloc(64 * 1024));
    safeSymlink(dir("real"), dir("node_modules"));

    const result = await scan(tmpDir, DEFAULT_CONFIG);
    const link = result.entries.find((entry) => entry.name === "node_modules");
    if (!link?.isSymlink) return; // symlink could not be created
    expect(link.estimatedBytes).toBeLessThan(64 * 1024);
  });

  test("abort signal stops sizing without throwing", async () => {
    mkdirSync(dir("node_modules"));
    mkdirSync(dir("dist"));
    const controller = new AbortController();
    const result = await scan(tmpDir, DEFAULT_CONFIG, false, {
      signal: controller.signal,
      onEntry: () => controller.abort(),
    });
    expect(result.entries.length).toBeGreaterThanOrEqual(0);
  });
});

test("apparent bytes are complete and deduplicate hard links per artifact", async () => {
  const { linkSync } = await import("node:fs");
  mkdirSync(dir("a", "node_modules"), { recursive: true });
  mkdirSync(dir("b", "node_modules"), { recursive: true });
  writeFileSync(dir("a", "node_modules", "shared"), Buffer.alloc(1000));
  linkSync(dir("a", "node_modules", "shared"), dir("a", "node_modules", "again"));
  linkSync(dir("a", "node_modules", "shared"), dir("b", "node_modules", "shared"));
  const result = await scan(tmpDir, DEFAULT_CONFIG);
  expect(result.estimatedTotalBytes).toBe(2000);
  expect(result.entries.map((entry) => entry.estimatedBytes)).toEqual([1000, 1000]);
  expect(result.entries.every((entry) => entry.bytesKnown === true)).toBe(true);
});

test("a full dedup set overcounts hardlinks but keeps the scan alive", async () => {
  if (process.platform === "win32") return;
  const { linkSync } = await import("node:fs");
  const target = dir("node_modules");
  mkdirSync(target);
  // One directory identity plus the first inode pair fill the shared cap;
  // the second pair counts twice - an upper bound flagged partial.
  writeFileSync(join(target, "a"), Buffer.alloc(64));
  linkSync(join(target, "a"), join(target, "a2"));
  writeFileSync(join(target, "b"), Buffer.alloc(64));
  linkSync(join(target, "b"), join(target, "b2"));
  const budget = new ResourceBudget({ maxIdentities: 2 });
  const size = await apparentSizeDetailed(target, undefined, budget);
  expect(size).toEqual({ bytes: 192, complete: false });
  expect(budget.sizingIdentity()).toBe(true);
  expect(budget.sizingIdentity()).toBe(true);
  expect(budget.sizingIdentity()).toBe(false);
  budget.releaseSizingIdentities(2);
});

test("sizing does not charge the scan-wide budget for transient dedup work", async () => {
  if (process.platform === "win32") return;
  const { linkSync } = await import("node:fs");
  const target = dir("node_modules");
  mkdirSync(target);
  // maxDirectories=1 would fail instantly if sizing charged it; maxIdentities=2
  // caps the dedup set so deeper subtrees flag partial instead of dying.
  const budget = new ResourceBudget({ maxIdentities: 2, maxDirectories: 1 });
  for (const sub of ["one", "two", "three"]) {
    mkdirSync(join(target, sub));
    writeFileSync(join(target, sub, "f"), Buffer.alloc(32));
    linkSync(join(target, sub, "f"), join(target, sub, "f2"));
  }
  const size = await apparentSizeDetailed(target, undefined, budget);
  expect(size.complete).toBe(false); // dedup capped - partial, not fatal
  expect(size.bytes).toBeGreaterThan(0);
  expect(() => budget.check()).not.toThrow();
});

// DT_UNKNOWN dirents: some filesystems (NFSv3, CIFS/SMB, FUSE) report "?"
// for every entry, so the only way to learn a type is lstat. The stub keeps
// real names but lies about the type - exactly what those filesystems do.
async function* allUnknownEntries(path: string | Buffer) {
  for (const name of await readdir(path)) {
    yield { name: Buffer.from(name as string | Buffer), type: "?" };
  }
}

test("DT_UNKNOWN dirs are re-lstatted: matched entries and descent both work", async () => {
  mkdirSync(dir("inner", "node_modules"), { recursive: true });
  mkdirSync(dir("node_modules"));
  writeFileSync(dir("node_modules", "f"), "x");

  stubDirectoryEntriesForTest(allUnknownEntries);
  try {
    const result = await scan(tmpDir, DEFAULT_CONFIG);

    // Without the fallback both real dirs stay invisible forever.
    expect(result.entries.map((entry) => entry.path).sort()).toEqual([
      dir("inner", "node_modules"),
      dir("node_modules"),
    ]);
    // The type comes from the lstat, not the dirent - a "?" entry must not
    // be stamped "file".
    expect(result.entries.every((entry) => entry.entryType === "directory")).toBe(true);
    expect(result.scannedDirs).toBeGreaterThanOrEqual(2);
  } finally {
    stubDirectoryEntriesForTest();
  }
});

test("a DT_UNKNOWN dirent that cannot be lstat'd marks its dir incomplete", async () => {
  mkdirSync(dir("node_modules"));

  stubDirectoryEntriesForTest(async function* (path) {
    yield* allUnknownEntries(path);
    // The filesystem reported a dirent that cannot be stat'd at all
    // (vanished mid-read / EIO) - the listing is incomplete, and the dir
    // must count as skipped rather than looking fully scanned.
    if (String(path) === tmpDir) {
      yield { name: Buffer.from("ghost-entry"), type: "?" };
    }
  });
  try {
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.skippedDirs).toBeGreaterThanOrEqual(1);
    expect(result.entries.map((entry) => entry.name)).toEqual(["node_modules"]);
  } finally {
    stubDirectoryEntriesForTest();
  }
});

test("a pre-aborted scan reports its unvisited queue as skipped, not complete", async () => {
  mkdirSync(dir("node_modules"));
  const controller = new AbortController();
  controller.abort();
  const result = await scan(tmpDir, DEFAULT_CONFIG, false, { signal: controller.signal });
  expect(result.entries).toHaveLength(0);
  // The root frame was queued but never walked - "looked at nothing" must
  // not read as "found nothing".
  expect(result.skippedDirs).toBeGreaterThanOrEqual(1);
});

test("an endless dirent stream is capped and the dir counts as skipped", async () => {
  // A hostile FUSE/NFS dir can yield dirents forever - bounded memory is not
  // enough when the walk itself never ends. The cap turns it into a skipped
  // dir instead of a scan that spins until killed.
  const junk = Buffer.from("junk-entry");
  stubDirectoryEntriesForTest(async function* () {
    // 4M+ iterations of a never-matching name; the scan must cut it off.
    for (let i = 0; i <= 4_000_000; i++) yield { name: junk, type: "f" };
  });
  try {
    const result = await scan(tmpDir, DEFAULT_CONFIG);
    expect(result.entries).toHaveLength(0);
    expect(result.skippedDirs).toBeGreaterThanOrEqual(1);
  } finally {
    stubDirectoryEntriesForTest();
  }
}, 60_000);

test("a throwing onEntrySized hook does not sink the scan's sizing", async () => {
  // The batch fails when a host hook throws; the per-entry fallback must
  // still size the batch (the dead `unsized` arm used to leave this fatal).
  mkdirSync(dir("node_modules"));
  writeFileSync(dir("node_modules", "f"), "hello");
  const sizer = new ProgressiveSizer({
    onEntrySized: () => {
      throw new Error("hook broke");
    },
  });
  const entry = {
    path: dir("node_modules"),
    name: "node_modules",
    entryType: "directory" as const,
    isSymlink: false,
    estimatedBytes: 0,
    bytesKnown: false,
  };
  sizer.add(entry);
  await sizer.finish();
  expect(entry.estimatedBytes).toBeGreaterThan(0);
  expect(entry.bytesKnown).toBe(true);
});

test("a resource-limit sizing failure still fails the scan", async () => {
  // Only budget failures are fatal - the latch lives in the shared budget.
  const budget = new ResourceBudget({ maxCandidates: 1 });
  budget.candidate("/a");
  expect(() => budget.candidate("/b")).toThrow("maxCandidates");
  const sizer = new ProgressiveSizer({}, undefined, budget);
  sizer.add({
    path: dir("node_modules"),
    name: "node_modules",
    entryType: "directory",
    isSymlink: false,
    estimatedBytes: 0,
  });
  await expect(sizer.finish()).rejects.toThrow("maxCandidates");
});

test("downstream backpressure pauses discovery until the consumer resumes", async () => {
  mkdirSync(dir("node_modules"));
  mkdirSync(dir("target"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = true;
  let revealed = 0;
  const scanning = scan(tmpDir, DEFAULT_CONFIG, false, {
    onEntry: () => {
      revealed++;
    },
    waitForConsumer: () => (blocked ? gate : undefined),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(revealed).toBe(0);
  blocked = false;
  release();
  const result = await scanning;
  expect(result.entries).toHaveLength(2);
  expect(revealed).toBe(2);
});

test("a failing output consumer cannot be swallowed by sizing fallback", async () => {
  mkdirSync(dir("node_modules"));
  writeFileSync(dir("node_modules", "f"), "hello");
  const sizer = new ProgressiveSizer({
    onEntrySized: () => {},
    waitForConsumer: async () => {
      throw new Error("consumer pipe closed");
    },
  });
  sizer.add({
    path: dir("node_modules"),
    name: "node_modules",
    entryType: "directory",
    isSymlink: false,
    estimatedBytes: 0,
  });
  await expect(sizer.finish()).rejects.toThrow("consumer pipe closed");
  await sizer.dispose();
});
