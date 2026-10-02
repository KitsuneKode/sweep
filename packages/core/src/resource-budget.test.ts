import { expect, test } from "bun:test";
import { ResourceBudget, checkedBytes } from "./resource-budget.js";

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
