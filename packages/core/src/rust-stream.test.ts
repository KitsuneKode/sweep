import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { RustScanStream } from "./rust-stream.js";

const target = join(tmpdir(), "sweep-stream");
const candidate: ScanCandidate = {
  id: "cand_stream",
  path: join(target, "node_modules"),
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
  test("discovery identity survives sizing and cannot be changed by an update", () => {
    const identity = { platform: "unix" as const, device: "123", inode: "9007199254740993" };
    const item = { ...candidate, identity };
    const stream = new RustScanStream(target);
    send(stream, { ...start, targetIdentity: identity });
    send(stream, { ...found, candidate: item });
    expect(() =>
      send(stream, {
        ...updated,
        candidate: { ...item, identity: { ...identity, inode: "9007199254740994" } },
      }),
    ).toThrow("update does not match discovery");
    send(stream, { ...updated, candidate: { ...item, estimatedBytes: 123 } });
    send(stream, complete);
    const result = stream.finish();
    expect(result.targetIdentity).toEqual(identity);
    expect(result.entries[0]?.identity).toEqual(identity);
  });

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
        candidate: { ...candidate, id: "other", path: join(target, "other") },
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

  test("sizing updates cannot replace retained classification metadata", () => {
    for (const patch of [
      { reasons: [...candidate.reasons, "new-reason"] },
      { kind: "custom" as const },
      { selectedByDefault: false },
    ]) {
      const stream = new RustScanStream(target);
      send(stream, start);
      send(stream, found);
      expect(() =>
        send(stream, { ...updated, candidate: { ...updated.candidate, ...patch } }),
      ).toThrow("update does not match discovery");
    }
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
      path: join(target, "dist"),
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

describe("stream candidate spelling and dedupe hardening", () => {
  test("rejects non-canonical candidate spellings", () => {
    for (const spelling of [`${target}/node_modules/`, `${target}/./node_modules`]) {
      const stream = new RustScanStream(target);
      send(stream, start);
      expect(() =>
        send(stream, {
          type: "candidate_found",
          candidate: { ...candidate, path: spelling },
        }),
      ).toThrow("canonical");
    }
  });

  test("rejects the target root under resolve-equal spellings", () => {
    // "/t/." and "/t/" hit the canonical-spelling gate first; the bare
    // exact spelling lands on resolved-path equality.
    for (const spelling of [`${target}/.`, `${target}/`]) {
      const stream = new RustScanStream(target);
      send(stream, start);
      expect(() =>
        send(stream, {
          type: "candidate_found",
          candidate: { ...candidate, path: spelling, name: "." },
        }),
      ).toThrow("canonical");
    }
    const stream = new RustScanStream(target);
    send(stream, start);
    expect(() =>
      send(stream, {
        type: "candidate_found",
        candidate: { ...candidate, path: target, name: target },
      }),
    ).toThrow("outside target");
  });

  test("rejects a second sizing update for the same candidate", () => {
    const stream = new RustScanStream(target);
    send(stream, start);
    send(stream, found);
    send(stream, updated);
    expect(() => send(stream, updated)).toThrow("duplicate scan candidate update");
  });

  test("rejects mistyped completion summary fields", () => {
    const stream = new RustScanStream(target);
    send(stream, start);
    send(stream, found);
    send(stream, updated);
    expect(() =>
      send(stream, {
        type: "scan_completed",
        summary: { ...complete.summary, skippedDirs: "1" },
      }),
    ).toThrow("skippedDirs");
  });

  test("rejects a kind outside the candidate-kind enum", () => {
    const stream = new RustScanStream(target);
    send(stream, start);
    expect(() =>
      send(stream, {
        type: "candidate_found",
        candidate: { ...candidate, kind: "definitely-not-a-kind" },
      }),
    ).toThrow("Invalid scan event");
  });
});
