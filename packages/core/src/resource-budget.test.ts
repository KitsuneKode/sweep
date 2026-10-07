import { expect, test } from "bun:test";
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
  expect(budget.sizingIdentity()).toBe(true); // 128 live sizing bytes
  expect(budget.sizingDirectory("b")).toBe(false);
  budget.releaseSizingIdentities(1);
  expect(budget.sizingDirectory("b")).toBe(false); // 132 would exceed 1156
  expect(budget.sizingIdentity()).toBe(true);
  expect(() => budget.identity()).toThrow("maxCombinedBytes");
});

test("live sizing reservations are shared, returned, and never poison discovery", () => {
  const budget = new ResourceBudget({
    maxIdentities: 1,
    maxQueuedDirs: 1,
    maxPathBytes: 4,
    maxRetainedBytes: 256,
  });
  expect(budget.sizingIdentity()).toBe(true);
  expect(budget.sizingIdentity()).toBe(false);
  expect(budget.sizingDirectory("a")).toBe(false);
  budget.releaseSizingIdentities(1);
  expect(budget.sizingDirectory("abcd")).toBe(true);
  expect(budget.sizingDirectory("a")).toBe(false);
  budget.releaseSizingDirectory("abcd");
  expect(budget.sizingDirectory("abcde")).toBe(false);
  expect(budget.sizingIdentity()).toBe(true);
  budget.releaseSizingIdentities(1);
  expect(() => budget.check()).not.toThrow();
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
