import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SELECTION_POLICY,
  PROTOCOL_VERSION,
  WIDGET_CACHE_SCHEMA,
  WIDGET_EVENT_SCHEMA,
  WIDGET_SNAPSHOT_SCHEMA,
  type ScanCandidate,
  type ScanPlan,
  type WidgetEvent,
  type WidgetReceipt,
} from "@kitsunekode/sweep-protocol";
import { PlanValidationError, validatePlan } from "./plan.js";
import {
  buildEmptyCacheSnapshot,
  buildWidgetErrorSnapshot,
  buildWidgetSnapshot,
  buildWidgetSuggestion,
  isValidWidgetSnapshot,
  parseWidgetDuration,
  readRecentWidgetReceipt,
  readWidgetCacheEntry,
  readWidgetCacheEnvelope,
  summarizeWidgetProjects,
  widgetErrorForCode,
  writeWidgetCacheEntry,
} from "./widget.js";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-28T12:00:00.000Z");

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeCandidate(overrides: Partial<ScanCandidate> & { id: string }): ScanCandidate {
  return {
    path: `/work/projects/app/${overrides.id}`,
    name: overrides.name ?? "node_modules",
    kind: overrides.kind ?? "node_modules",
    estimatedBytes: overrides.estimatedBytes ?? 1024,
    bytesKnown: true,
    isSymlink: false,
    entryType: "directory",
    riskTier: overrides.riskTier ?? "safe",
    reasons: ["default-pattern"],
    selectedByDefault: true,
    ...overrides,
  };
}

function makePlan(candidates: ScanCandidate[], overrides: Partial<ScanPlan> = {}): ScanPlan {
  return {
    protocolVersion: PROTOCOL_VERSION,
    targetDir: "/work/projects",
    selectionPolicy: DEFAULT_SELECTION_POLICY,
    candidates,
    summary: {
      candidateCount: candidates.length,
      estimatedTotalBytes: candidates.reduce((s, c) => s + c.estimatedBytes, 0),
      scannedDirs: 25,
      skippedDirs: 0,
      exact: false,
      selectedCount: candidates.filter((c) => c.selectedByDefault).length,
      riskCounts: {
        safe: candidates.filter((c) => c.riskTier === "safe").length,
        caution: candidates.filter((c) => c.riskTier === "caution").length,
        dangerous: candidates.filter((c) => c.riskTier === "dangerous").length,
        blocked: candidates.filter((c) => c.riskTier === "blocked").length,
      },
    },
    selectedCandidateIds: candidates.filter((c) => c.selectedByDefault).map((c) => c.id),
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe("widget summary and trust invariants", () => {
  test("counts safe + caution as reclaimable, keeps guarded separate, and computes worktree byCost strictly from merged worktrees", () => {
    const plan = makePlan([
      // Finished (merged) worktree: cache + install + build
      makeCandidate({
        id: "wt_cache",
        name: ".turbo",
        kind: ".turbo",
        estimatedBytes: 200,
        riskTier: "safe",
        projectRoot: "/work/projects/sweep/.worktrees/old-renderer",
        projectActiveMs: NOW - 42 * DAY_MS,
        worktreeOf: "/work/projects/sweep",
        worktreeState: "merged",
      }),
      makeCandidate({
        id: "wt_install",
        name: "node_modules",
        kind: "node_modules",
        estimatedBytes: 1000,
        riskTier: "safe",
        projectRoot: "/work/projects/sweep/.worktrees/old-renderer",
        projectActiveMs: NOW - 42 * DAY_MS,
        worktreeOf: "/work/projects/sweep",
        worktreeState: "merged",
      }),
      makeCandidate({
        id: "wt_build",
        name: ".next",
        kind: ".next",
        estimatedBytes: 500,
        riskTier: "caution",
        projectRoot: "/work/projects/sweep/.worktrees/old-renderer",
        projectActiveMs: NOW - 42 * DAY_MS,
        worktreeOf: "/work/projects/sweep",
        worktreeState: "merged",
      }),
      // upstream_gone worktree is NEVER counted as finished
      makeCandidate({
        id: "wt_gone",
        name: "node_modules",
        kind: "node_modules",
        estimatedBytes: 700,
        riskTier: "safe",
        projectRoot: "/work/projects/sweep/.worktrees/gone-branch",
        projectActiveMs: NOW - 45 * DAY_MS,
        worktreeOf: "/work/projects/sweep",
        worktreeState: "upstream_gone",
      }),
      // Dangerous and blocked items must never inflate reclaimableBytes
      makeCandidate({
        id: "danger_1",
        name: "dist",
        kind: "dist",
        estimatedBytes: 9_000,
        riskTier: "dangerous",
        selectedByDefault: false,
        projectRoot: "/work/projects/active-app",
        projectActiveMs: NOW - 2 * DAY_MS,
      }),
      makeCandidate({
        id: "blocked_1",
        name: "src",
        kind: "custom",
        estimatedBytes: 5_000,
        riskTier: "blocked",
        selectedByDefault: false,
        projectRoot: "/work/projects/active-app",
        projectActiveMs: NOW - 2 * DAY_MS,
      }),
      // Opt-in custom caution item
      makeCandidate({
        id: "custom_1",
        name: ".venv",
        kind: "custom",
        estimatedBytes: 300,
        riskTier: "caution",
        projectRoot: "/work/projects/py-app",
        projectActiveMs: NOW - 10 * DAY_MS,
      }),
    ]);

    const summary = summarizeWidgetProjects(plan, { nowMs: NOW });

    expect(summary.safeBytes).toBe(1900);
    expect(summary.cautionBytes).toBe(800);
    expect(summary.reclaimableBytes).toBe(2700);
    expect(summary.guardedBytes).toBe(14_000);
    expect(summary.protectedCount).toBe(2);
    expect(summary.projectCount).toBe(3);

    // byCost sums strictly to reclaimableBytes
    expect(summary.byCost.reduce((s, b) => s + b.bytes, 0)).toBe(summary.reclaimableBytes);
    expect(summary.byCost.map((b) => b.cost)).toEqual(["cache", "install", "build", "custom"]);

    // Only merged worktree counts as finished; worktrees.byCost sums strictly to worktrees.bytes
    expect(summary.worktrees.finished).toBe(1);
    expect(summary.worktrees.bytes).toBe(1700);
    expect(summary.worktrees.byCost.reduce((s, b) => s + b.bytes, 0)).toBe(1700);
    expect(summary.worktrees.byCost.map((b) => b.cost)).toEqual(["cache", "install", "build"]);

    // Both 42d and 45d projects are idle (>= 30d)
    expect(summary.idle).toEqual({ days: 30, projects: 2, bytes: 2400 });

    // Top kinds are reclaimable-only and sorted largest first
    expect(summary.topKinds[0]).toEqual({ kind: "node_modules", bytes: 1700, count: 2 });
    expect(summary.topKinds.some((k) => k.kind === "dist")).toBe(false);

    // Suggestion prioritizes finished worktrees
    const suggestion = buildWidgetSuggestion(summary);
    expect(suggestion?.kind).toBe("worktrees");
    expect(suggestion?.action).toEqual({
      intent: "review_projects",
      label: "Review 1 worktree",
      view: "projects",
      focus: "worktrees",
    });
  });

  test("caps topKinds at 8 and topProjects at 10 for bounded output size", () => {
    const kinds = [
      "node_modules",
      "target",
      ".next",
      ".nuxt",
      ".svelte-kit",
      ".turbo",
      ".vite",
      ".parcel-cache",
      "coverage",
      ".nyc_output",
      "tsbuildinfo",
    ] as const;

    const candidates: ScanCandidate[] = [];
    for (let i = 0; i < 15; i++) {
      const kind = kinds[i % kinds.length]!;
      candidates.push(
        makeCandidate({
          id: `c_${i}`,
          name: kind,
          kind,
          estimatedBytes: (15 - i) * 1000,
          projectRoot: `/work/projects/proj-${i}`,
          projectActiveMs: NOW - 40 * DAY_MS,
        }),
      );
    }

    const summary = summarizeWidgetProjects(makePlan(candidates), { nowMs: NOW });
    expect(summary.topKinds.length).toBeLessThanOrEqual(8);
    expect(summary.topProjects.length).toBeLessThanOrEqual(10);
  });

  test("loadPlan / validatePlan unconditionally rejects WidgetSnapshot documents", () => {
    const snapshot = buildWidgetSnapshot(makePlan([]), { nowMs: NOW, disk: null });
    expect(snapshot.readOnly).toBe(true);
    expect(() => validatePlan(snapshot)).toThrow(PlanValidationError);
    expect(() => validatePlan(snapshot)).toThrow(/widget snapshots are read-only/);
  });
});

describe("widget JSON Schema Ajv contract validation", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  ajv.addSchema(WIDGET_SNAPSHOT_SCHEMA);
  const validateSnapshot = ajv.compile(WIDGET_SNAPSHOT_SCHEMA);
  const validateEvent = ajv.compile(WIDGET_EVENT_SCHEMA);
  const validateCache = ajv.compile(WIDGET_CACHE_SCHEMA);

  test("validates settled, empty, stale cache, error snapshots, streaming events, and cache envelope", () => {
    const settled = buildWidgetSnapshot(
      makePlan([
        makeCandidate({
          id: "nm",
          estimatedBytes: 2048,
          projectRoot: "/work/projects/demo",
          projectActiveMs: NOW - 35 * DAY_MS,
        }),
      ]),
      {
        nowMs: NOW,
        elapsedMs: 120,
        disk: { mountPoint: "/work", totalBytes: 1000, usedBytes: 600, freeBytes: 400 },
      },
    );
    expect(settled.state).toBe("ok");
    expect(validateSnapshot(settled)).toBe(true);

    const empty = buildWidgetSnapshot(makePlan([]), { nowMs: NOW, disk: null });
    expect(empty.state).toBe("empty");
    expect(empty.suggestion).toBeNull();
    expect(validateSnapshot(empty)).toBe(true);

    const emptyCache = buildEmptyCacheSnapshot("/work/projects", { nowMs: NOW, disk: null });
    expect(emptyCache.state).toBe("stale");
    expect(emptyCache.source).toBe("cache");
    expect(validateSnapshot(emptyCache)).toBe(true);

    for (const code of [
      "engine_missing",
      "permission_denied",
      "target_missing",
      "timeout",
      "scan_failed",
    ] as const) {
      const errSnap = buildWidgetErrorSnapshot("/work/projects", widgetErrorForCode(code), {
        nowMs: NOW,
      });
      expect(errSnap.state).toBe("error");
      expect(validateSnapshot(errSnap)).toBe(true);
      // Error messages must stay plain and never leak stack traces or OS paths.
      expect(errSnap.error?.message).not.toMatch(/\/|Error:|stack|exit code/i);
    }

    const events: WidgetEvent[] = [
      {
        type: "widget_started",
        widgetSchemaVersion: 1,
        view: "projects",
        targetDir: "/work/projects",
        startedAt: new Date(NOW).toISOString(),
      },
      {
        type: "widget_progress",
        widgetSchemaVersion: 1,
        view: "projects",
        scannedDirs: 10,
        found: 2,
        sizedCount: 1,
        estimatedBytes: 2048,
        currentDir: "demo/node_modules",
        byCost: [{ cost: "install", bytes: 2048 }],
      },
      {
        type: "widget_snapshot",
        widgetSchemaVersion: 1,
        snapshot: settled,
      },
      {
        type: "widget_error",
        widgetSchemaVersion: 1,
        error: widgetErrorForCode("timeout"),
      },
    ];
    for (const ev of events) {
      expect(validateEvent(ev)).toBe(true);
    }

    const envelope = { cacheVersion: 1, entries: { "/work/projects": settled } };
    expect(validateCache(envelope)).toBe(true);
  });
});

describe("widget L4 cache and receipts", () => {
  test("writes atomic 0600 multi-entry cache, enforces 8-entry cap, computes ageMs/stale, and refuses symlinks", () => {
    const dir = makeTempDir("sweep-widget-cache-");
    const cachePath = join(dir, "widget-v1.json");

    for (let i = 0; i < 10; i++) {
      const target = `/work/projects/root-${i}`;
      const snap = buildWidgetSnapshot(
        makePlan(
          [
            makeCandidate({
              id: `c_${i}`,
              path: `${target}/app/node_modules`,
              projectRoot: `${target}/app`,
              estimatedBytes: 1024 * (i + 1),
            }),
          ],
          { targetDir: target, createdAt: new Date(NOW + i * 1000).toISOString() },
        ),
        { nowMs: NOW + i * 1000, disk: null },
      );
      expect(writeWidgetCacheEntry(snap, { cachePath })).toBe(true);
    }

    if (process.platform !== "win32") {
      expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    }

    const envelope = readWidgetCacheEnvelope(cachePath);
    expect(Object.keys(envelope.entries)).toHaveLength(8);
    // Oldest two roots (0, 1) were evicted; newest root (9) is retained.
    expect(envelope.entries["/work/projects/root-0"]).toBeUndefined();
    expect(envelope.entries["/work/projects/root-9"]).toBeDefined();

    // Fresh cache read (< 60m)
    const fresh = readWidgetCacheEntry("/work/projects/root-9", {
      cachePath,
      nowMs: NOW + 9_000 + 5 * 60_000,
    });
    expect(fresh?.source).toBe("cache");
    expect(fresh?.ageMs).toBe(5 * 60_000);
    expect(fresh?.stale).toBe(false);
    expect(fresh?.state).toBe("ok");
    expect(isValidWidgetSnapshot(fresh)).toBe(true);

    // Stale cache read (>= 60m)
    const stale = readWidgetCacheEntry("/work/projects/root-9", {
      cachePath,
      nowMs: NOW + 9_000 + 90 * 60_000,
    });
    expect(stale?.stale).toBe(true);
    expect(stale?.state).toBe("stale");
    expect(stale?.ageMs).toBe(90 * 60_000);

    // Symlink at cachePath must be refused for both reads and writes.
    const realFile = join(dir, "real.json");
    const linkPath = join(dir, "link.json");
    writeFileSync(realFile, "{}");
    symlinkSync(realFile, linkPath);
    expect(readWidgetCacheEntry("/work/projects/root-9", { cachePath: linkPath })).toBeNull();
    const snap = buildWidgetSnapshot(makePlan([]), { nowMs: NOW, disk: null });
    expect(writeWidgetCacheEntry(snap, { cachePath: linkPath })).toBe(false);
  });

  test("reads recent matching receipt and ignores expired or mismatched receipts", () => {
    const dir = makeTempDir("sweep-widget-receipt-");
    const receiptPath = join(dir, "last-receipt.json");
    const receipt: WidgetReceipt = {
      receiptVersion: 1,
      id: "01JDX9R6H8Q7N4K2V1M8W5B3C0",
      completedAt: new Date(NOW - 30 * 60_000).toISOString(),
      targetDir: "/work/projects",
      mode: "delete",
      deletedCount: 2,
      failedCount: 0,
      unattemptedCount: 0,
      stopped: false,
      totalBytesFreed: 4096,
      freeBytesAfter: 100_000,
      failureSummary: null,
    };
    writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });

    expect(readRecentWidgetReceipt("/work/projects", { nowMs: NOW, receiptPath })).toEqual(receipt);
    expect(readRecentWidgetReceipt("/work/other", { nowMs: NOW, receiptPath })).toBeNull();
    // Expired after 24h
    expect(
      readRecentWidgetReceipt("/work/projects", { nowMs: NOW + 25 * 3_600_000, receiptPath }),
    ).toBeNull();
  });

  test("parseWidgetDuration accepts valid units and rejects malformed values", () => {
    expect(parseWidgetDuration("0s")).toBe(0);
    expect(parseWidgetDuration("45s")).toBe(45_000);
    expect(parseWidgetDuration("30m")).toBe(1_800_000);
    expect(parseWidgetDuration("2h")).toBe(7_200_000);
    expect(parseWidgetDuration("1d")).toBe(DAY_MS);
    expect(() => parseWidgetDuration("-5s")).toThrow();
    expect(() => parseWidgetDuration("10x")).toThrow();
    expect(() => parseWidgetDuration("abc")).toThrow();
  });
});
