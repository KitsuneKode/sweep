import { expect, test } from "bun:test";
import { candidateIndex, clearCandidateIndex } from "./candidate-index.js";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";

test("shared candidate lookups do not mutate a previous revision during sizing or rescan", () => {
  const first: ScanCandidate = {
    id: "candidate",
    path: "/tmp/index/node_modules",
    name: "node_modules",
    kind: "node_modules",
    entryType: "directory",
    isSymlink: false,
    estimatedBytes: 0,
    bytesKnown: false,
    riskTier: "safe",
    selectedByDefault: true,
    reasons: [],
  };
  const discovered = [first];
  const original = candidateIndex(discovered);
  expect(candidateIndex(discovered)).toBe(original);
  const sized = [{ ...first, estimatedBytes: 123, bytesKnown: true }];
  expect(candidateIndex(sized).get(first.id)?.estimatedBytes).toBe(123);
  expect(original.get(first.id)?.estimatedBytes).toBe(0);
  clearCandidateIndex();
  expect(candidateIndex([]).size).toBe(0);
  expect(candidateIndex(discovered).get(first.id)).toBe(first);
  clearCandidateIndex();
});
