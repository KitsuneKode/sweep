import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { RustScanStream } from "./rust-stream.js";

const target = "/tmp/sweep-stream";
const candidate: ScanCandidate = {
  id: "cand_stream",
  path: `${target}/node_modules`,
  name: "node_modules",
  kind: "node_modules",
  estimatedBytes: 0,
  isSymlink: false,
  entryType: "directory",
  riskTier: "safe",
  reasons: ["default-pattern"],
  selectedByDefault: true,
};
const start = { type: "scan_started", targetDir: target };
const found = { type: "candidate_found", candidate };
const updated = { type: "candidate_updated", candidate: { ...candidate, estimatedBytes: 123 } };
const complete = {
  type: "scan_completed",
  summary: { candidateCount: 1, estimatedTotalBytes: 123, scannedDirs: 2, exact: false },
};
const send = (stream: RustScanStream, event: unknown) => stream.push(JSON.stringify(event));

describe("Rust scan stream contract", () => {
  test("a native stream cannot exceed the host candidate budget", () => {
    let revealed = 0;
    const stream = new RustScanStream(target, {
      limits: { maxCandidates: 1 },
      onEntry: () => revealed++,
    });
    send(stream, start);
    send(stream, found);
    expect(() =>
      send(stream, {
        type: "candidate_found",
        candidate: { ...candidate, id: "other", path: `${target}/other` },
      }),
    ).toThrow("maxCandidates");
    expect(revealed).toBe(1);
    expect(() => stream.finish()).toThrow("incomplete");
  });

  test("unsafe byte counters are rejected before UI feedback", () => {
    const stream = new RustScanStream(target);
    send(stream, start);
    expect(() =>
      send(stream, { ...found, candidate: { ...candidate, estimatedBytes: 2 ** 53 } }),
    ).toThrow("Invalid scan event");
  });

  test("reveals discovery and size updates progressively and completes consistently", () => {
    const bytes: number[] = [];
    const stream = new RustScanStream(target, {
      onEntry: (entry) => bytes.push(entry.estimatedBytes),
      onEntrySized: (entry) => bytes.push(entry.estimatedBytes),
    });
    send(stream, start);
    send(stream, found);
    expect(bytes).toEqual([0]);
    send(stream, updated);
    expect(bytes).toEqual([0, 123]);
    send(stream, complete);
    expect(stream.finish().entries[0]?.estimatedBytes).toBe(123);
  });

  test("accepts batched candidate events with per-candidate validation", () => {
    const other: ScanCandidate = {
      ...candidate,
      id: "cand_stream_2",
      path: `${target}/dist`,
      name: "dist",
      kind: "custom",
    };
    const bytes: number[] = [];
    const stream = new RustScanStream(target, {
      onEntry: (entry) => bytes.push(entry.estimatedBytes),
      onEntrySized: (entry) => bytes.push(entry.estimatedBytes),
    });
    send(stream, start);
    send(stream, { type: "candidates_found", candidates: [candidate, other] });
    expect(bytes).toEqual([0, 0]);
    send(stream, {
      type: "candidates_updated",
      candidates: [
        { ...candidate, estimatedBytes: 123 },
        { ...other, estimatedBytes: 7 },
      ],
    });
    expect(bytes).toEqual([0, 0, 123, 7]);
    send(stream, {
      type: "scan_completed",
      summary: { candidateCount: 2, estimatedTotalBytes: 130, scannedDirs: 2, exact: false },
    });
    const result = stream.finish();
    expect(result.entries.map((entry) => entry.estimatedBytes).sort((a, b) => a - b)).toEqual([
      7, 123,
    ]);
  });

  test("rejects malformed batch members and updates without discovery", () => {
    const stream = new RustScanStream(target);
    send(stream, start);
    expect(() =>
      send(stream, {
        type: "candidates_found",
        candidates: [{ ...candidate, estimatedBytes: -1 }],
      }),
    ).toThrow("Invalid");
    expect(() =>
      send(stream, {
        type: "candidates_updated",
        candidates: [{ ...candidate, estimatedBytes: 5 }],
      }),
    ).toThrow("discovery");
  });

  test("carries bytesKnown from sized updates into result entries", () => {
    const stream = new RustScanStream(target);
    send(stream, start);
    send(stream, found);
    send(stream, {
      type: "candidate_updated",
      candidate: { ...candidate, estimatedBytes: 64, bytesKnown: false },
    });
    send(stream, {
      type: "scan_completed",
      summary: { candidateCount: 1, estimatedTotalBytes: 64, scannedDirs: 2, exact: false },
    });
    const result = stream.finish();
    expect(result.entries[0]?.estimatedBytes).toBe(64);
    expect(result.entries[0]?.bytesKnown).toBe(false);
  });

  test("rejects malformed JSON and invalid event fields", () => {
    expect(() => new RustScanStream(target).push("invalid json")).toThrow("Invalid");
    const stream = new RustScanStream(target);
    send(stream, start);
    expect(() =>
      send(stream, { ...found, candidate: { ...candidate, estimatedBytes: -1 } }),
    ).toThrow("Invalid");
  });

  test("rejects truncation, missing sizing, wrong target and inconsistent completion", () => {
    expect(() => new RustScanStream(target).finish()).toThrow("incomplete");
    expect(() => send(new RustScanStream(target), { ...start, targetDir: "/tmp/other" })).toThrow(
      "target",
    );
    const stream = new RustScanStream(target);
    send(stream, start);
    send(stream, found);
    expect(() => send(stream, complete)).toThrow("incomplete");
    send(stream, updated);
    expect(() =>
      send(stream, { ...complete, summary: { ...complete.summary, candidateCount: 2 } }),
    ).toThrow("summary");
    expect(() =>
      send(stream, { ...complete, summary: { ...complete.summary, estimatedTotalBytes: 0 } }),
    ).toThrow("summary");
  });

  test("rejects events out of order or after completion", () => {
    expect(() => send(new RustScanStream(target), found)).toThrow("started");
    const stream = new RustScanStream(target);
    send(stream, start);
    expect(() => send(stream, updated)).toThrow("discovery");
    send(stream, found);
    expect(() => send(stream, found)).toThrow("duplicate");
    send(stream, updated);
    send(stream, complete);
    expect(() => send(stream, found)).toThrow("completed");
  });
});
