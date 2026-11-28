import { expect, test } from "bun:test";
import { SCAN_RESOURCE_PROFILES } from "@kitsunekode/sweep-protocol";
import {
  ResourceBudget,
  checkedBytes,
  candidateFieldChars,
  discoveryCandidateFieldChars,
} from "./resource-budget.js";
import { toCandidate } from "./planner.js";
import { enrichCandidates } from "./candidate-insights.js";

test("discovery and live sizing cannot each consume the combined allowance", () => {
  const budget = new ResourceBudget({ maxRetainedBytes: 2048, maxCombinedBytes: 1156 });
  budget.candidate("a"); // 1028 discovery bytes
  expect(budget.sizingDirectoryIdentity()).toBe(true); // 128 live sizing bytes
  expect(budget.sizingDirectory("b")).toBe(false);
  budget.releaseSizingDirectoryIdentities(1);
  expect(budget.sizingDirectory("b")).toBe(false); // 132 would exceed 1156
  expect(budget.sizingDirectoryIdentity()).toBe(true);
  expect(() => budget.identity()).toThrow("maxCombinedBytes");
});

test("scan-wide hardlink retention participates in the combined sizing allowance", () => {
  const identities = new ResourceBudget({ maxRetainedBytes: 4096, maxCombinedBytes: 256 });
  expect(identities.hardlinkIdentity()).toBe(true);
  expect(identities.sizingDirectoryIdentity()).toBe(true);
  expect(identities.sizingHardlinkIdentity()).toBe(false);

  const directories = new ResourceBudget({ maxRetainedBytes: 4096, maxCombinedBytes: 256 });
  expect(directories.hardlinkIdentity()).toBe(true);
  expect(directories.sizingDirectory("abcd")).toBe(false);
});

test("live sizing reservations are shared, returned, and never poison discovery", () => {
  const budget = new ResourceBudget({
    maxIdentities: 1,
    maxQueuedDirs: 1,
    maxPathBytes: 4,
    maxRetainedBytes: 256,
  });
  expect(budget.sizingDirectoryIdentity()).toBe(true);
  expect(budget.sizingDirectoryIdentity()).toBe(false);
  expect(budget.sizingDirectory("a")).toBe(false);
  budget.releaseSizingDirectoryIdentities(1);
  expect(budget.sizingDirectory("abcd")).toBe(true);
  expect(budget.sizingDirectory("a")).toBe(false);
  budget.releaseSizingDirectory("abcd");
  expect(budget.sizingDirectory("abcde")).toBe(false);
  expect(budget.sizingDirectoryIdentity()).toBe(true);
  budget.releaseSizingDirectoryIdentities(1);
  expect(() => budget.check()).not.toThrow();
});

test("hardlink sizing identities do not consume directory identity slots", () => {
  const budget = new ResourceBudget({ maxIdentities: 2 });
  expect(budget.sizingHardlinkIdentity()).toBe(true);
  expect(budget.sizingHardlinkIdentity()).toBe(true);
  expect(budget.sizingHardlinkIdentity()).toBe(false);

  expect(budget.sizingDirectoryIdentity()).toBe(true);
  expect(budget.sizingDirectoryIdentity()).toBe(true);
  expect(budget.sizingDirectoryIdentity()).toBe(false);

  budget.releaseSizingHardlinkIdentities(1);
  expect(budget.sizingHardlinkIdentity()).toBe(true);
  expect(budget.sizingDirectoryIdentity()).toBe(false);
  budget.releaseSizingHardlinkIdentities(2);
  budget.releaseSizingDirectoryIdentities(2);
  expect(() => budget.check()).not.toThrow();
});

test("hardlink byte share preserves directory sizing headroom", () => {
  const budget = new ResourceBudget({
    maxIdentities: 100,
    maxRetainedBytes: 1024,
    maxCombinedBytes: 2048,
  });
  expect(budget.sizingHardlinkIdentityCap()).toBe(4);
  for (let i = 0; i < 4; i += 1) expect(budget.sizingHardlinkIdentity()).toBe(true);
  expect(budget.sizingHardlinkIdentity()).toBe(false);

  // The saturated hardlink lane owns only half the retained-byte budget, so
  // directory-cycle identities still have the other half available.
  for (let i = 0; i < 4; i += 1) expect(budget.sizingDirectoryIdentity()).toBe(true);
  expect(budget.sizingDirectoryIdentity()).toBe(false);
  budget.releaseSizingHardlinkIdentities(4);
  budget.releaseSizingDirectoryIdentities(4);
  expect(() => budget.check()).not.toThrow();
});

test("low-memory hardlink identity cap derives from the byte share", () => {
  const budget = new ResourceBudget(SCAN_RESOURCE_PROFILES["low-memory"]);
  expect(budget.sizingHardlinkIdentityCap()).toBe(32_768);
  expect(budget.sizingHardlinkIdentityCap()).toBeLessThan(
    SCAN_RESOURCE_PROFILES["low-memory"].maxIdentities,
  );
});

test("queued paths are bounded and dequeued slots are reusable", () => {
  const budget = new ResourceBudget({ maxQueuedDirs: 1 });
  budget.directory("a");
  budget.dequeueDirectory();
  budget.directory("b");
  expect(() => budget.directory("c")).toThrow("maxQueuedDirs");
  expect(() => budget.candidate("d")).toThrow("maxQueuedDirs");
});

test("candidates, identities and conservative memory charges are bounded", () => {
  const candidate = new ResourceBudget({ maxCandidates: 1 });
  candidate.candidate("a");
  expect(() => candidate.candidate("b")).toThrow("maxCandidates");
  const identity = new ResourceBudget({ maxIdentities: 1 });
  identity.identity();
  expect(() => identity.identity()).toThrow("maxIdentities");
  expect(() => new ResourceBudget({ maxPathBytes: 3 }).directory("😊")).toThrow("maxPathBytes");
  expect(() => new ResourceBudget({ maxRetainedBytes: 1024 }).candidate("a")).toThrow(
    "maxRetainedBytes",
  );
});

test("invalid limits and unsafe byte arithmetic fail explicitly", () => {
  for (const n of [0, -1, 0.5, NaN, Infinity, 2 ** 32])
    expect(() => new ResourceBudget({ maxCandidates: n })).toThrow("Invalid scan limit");
  expect(checkedBytes(Number.MAX_SAFE_INTEGER - 1, 1)).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => checkedBytes(Number.MAX_SAFE_INTEGER, 1)).toThrow("overflow");
  expect(() => checkedBytes(-1, 1)).toThrow("overflow");
});

test("discovery reserves workspace enrichment without counting its reasons twice", () => {
  const stub = toCandidate({
    path: "/tmp/budget/app/node_modules",
    name: "node_modules",
    entryType: "directory",
    isSymlink: false,
    estimatedBytes: 4096,
  });
  const primary = toCandidate({
    ...stub,
    path: "/tmp/budget/node_modules",
    estimatedBytes: 2 * 1024 ** 2,
  });
  const enriched = enrichCandidates([stub, primary])[0]!;
  expect(enriched.reasons).toContain("workspace-stub");
  expect(discoveryCandidateFieldChars(stub)).toBe(candidateFieldChars(enriched));
  expect(discoveryCandidateFieldChars(enriched)).toBe(candidateFieldChars(enriched));
  const unicode = { ...stub, name: "🦊", reasons: ["日本語"] };
  expect(candidateFieldChars(unicode)).toBe(unicode.id.length + 2 + unicode.kind.length + 3);
});
