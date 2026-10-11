/** Read-only synthetic index qualification; never scans or removes filesystem entries. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { compileFilter } from "../src/filter-query.js";

const args = process.argv.slice(2);
const binaryFlag = args.indexOf("--binary");
if (binaryFlag < 0 || !args[binaryFlag + 1])
  throw new Error("Pass --binary PATH to a freshly built native engine");
const binary = resolve(args[binaryFlag + 1]!);
const outputFlag = args.indexOf("--output");
const output = outputFlag >= 0 ? args[outputFlag + 1] : undefined;
const now = Date.UTC(2026, 9, 8);
const filters = [
  "",
  "kind:target",
  ">=1MiB !risk:blocked",
  "is:queued",
  "older:30d",
  "newer:7d",
  "is:symlink",
  "is:stub",
  "path:group-2",
  "!is:dir",
  "kind:",
  ">1",
  "risk:unknown",
  "東京",
  "kind:target\uFEFF!risk:blocked",
  "kind:target\u0085!risk:blocked",
];

interface Summary {
  generation: string;
  revision: number;
  candidateCount: number;
  selectedCount: number;
  retainedBytes: number;
}
interface Page {
  generation: string;
  revision: number;
  matchingCount: number;
  matchingBytes: number;
  matchingBytesPartial: boolean;
  nextOffset: number | null;
  candidates: ScanCandidate[];
  summary: Summary;
}
interface Reply {
  type: string;
  requestId?: number;
  page?: Page;
  summary?: Summary;
  message?: string;
}

function snapshot(count: number): ScanPlan {
  const targetDir = join(tmpdir(), "sweep-readonly-index-fixture");
  const candidates: ScanCandidate[] = Array.from({ length: count }, (_, index) => {
    const name = index % 2 ? "target" : "node_modules";
    const isSymlink = index % 13 === 0;
    return {
      id: `cand_index_${index}`,
      path: join(
        targetDir,
        `group-${Math.floor(index / 100)}`,
        `project-${index}${index % 11 === 0 ? "-東京" : ""}`,
        name,
      ),
      name,
      kind: name,
      entryType: isSymlink ? "symlink" : "directory",
      isSymlink,
      estimatedBytes: (index % 4096) * 1024,
      bytesKnown: index % 19 !== 0,
      ...(index % 23 ? { modifiedMs: now - (index % 90) * 86_400_000 } : {}),
      riskTier: index % 17 === 0 ? "blocked" : index % 7 === 0 ? "caution" : "safe",
      reasons: index % 10 === 0 ? ["workspace-stub"] : ["default-pattern"],
      selectedByDefault: true,
    };
  });
  const riskCounts = { safe: 0, caution: 0, dangerous: 0, blocked: 0 };
  for (const candidate of candidates) riskCounts[candidate.riskTier]++;
  const selectedCandidateIds = candidates
    .filter((candidate) => candidate.riskTier !== "blocked")
    .slice(0, 50)
    .map((candidate) => candidate.id);
  return {
    protocolVersion: "1",
    targetDir,
    candidates,
    selectedCandidateIds,
    createdAt: new Date(now).toISOString(),
    selectionPolicy: { mode: "default", includeDangerous: false },
    summary: {
      candidateCount: count,
      estimatedTotalBytes: candidates.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
      scannedDirs: count,
      exact: false,
      selectedCount: selectedCandidateIds.length,
      riskCounts,
    },
  };
}

function client() {
  const child = spawn(binary, ["index"], { stdio: "pipe" });
  let carry = "";
  let replyBytes = 0;
  let maxReplyBytes = 0;
  let stderr = "";
  let pending:
    | {
        resolve: (reply: Reply) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const exit = new Promise<number | null>((done) => child.once("exit", done));
  const fail = (error: Error) => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = undefined;
    }
  };
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.once("close", () => fail(new Error(`Index closed before a reply: ${stderr}`)));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    replyBytes += Buffer.byteLength(chunk);
    if (replyBytes > 1024 * 1024) {
      fail(new Error("Index reply exceeds 1 MiB"));
      child.kill("SIGKILL");
      return;
    }
    carry += chunk;
    const end = carry.indexOf("\n");
    if (end < 0) return;
    if (!pending || end !== carry.length - 1) {
      fail(new Error("Unexpected or multiple index replies"));
      child.kill("SIGKILL");
      return;
    }
    const line = carry.slice(0, end);
    carry = "";
    maxReplyBytes = Math.max(maxReplyBytes, replyBytes);
    replyBytes = 0;
    const waiting = pending;
    pending = undefined;
    clearTimeout(waiting.timer);
    try {
      waiting.resolve(JSON.parse(line) as Reply);
    } catch {
      waiting.reject(new Error("Invalid JSON index reply"));
    }
  });
  const send = (message: unknown) => {
    assert.equal(pending, undefined, "only one request may be outstanding");
    return new Promise<Reply>((done, reject) => {
      const timer = setTimeout(() => {
        fail(new Error("Index reply timeout"));
        child.kill("SIGKILL");
      }, 30_000);
      pending = { resolve: done, reject, timer };
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) fail(error);
      });
    });
  };
  return {
    child,
    send,
    exit,
    get maxReplyBytes() {
      return maxReplyBytes;
    },
    close() {
      child.kill("SIGKILL");
    },
  };
}

function latency(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    samples: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

const results = [];
for (const count of [5000, 50000, 100000]) {
  const plan = snapshot(count);
  const selectedIds = new Set(plan.selectedCandidateIds);
  const context = { selectedIds, now };
  const generation = `benchmark-${count}`;
  const channel = client();
  const started = performance.now();
  try {
    const initBytes = Buffer.byteLength(JSON.stringify({ generation, plan })) + 1;
    assert.ok(initBytes <= 64 * 1024 * 1024);
    const ready = await channel.send({ generation, plan });
    const initMs = performance.now() - started;
    assert.equal(ready.type, "index_ready");
    assert.equal(ready.summary?.candidateCount, count);
    assert.equal(ready.summary?.selectedCount, selectedIds.size);
    assert.ok(ready.summary!.retainedBytes <= 64 * 1024 * 1024);
    let requestId = 0;
    const nativeMs = [];
    const jsMs = [];
    for (let sample = 0; sample < 200; sample++) {
      const filter = filters[sample % filters.length]!;
      const offset = (sample % 3) * 128;
      const jsStart = performance.now();
      const predicate = compileFilter(filter);
      const matching = predicate
        ? plan.candidates.filter((candidate) => predicate(candidate, context))
        : plan.candidates;
      const expected = matching.slice(offset, offset + 128);
      jsMs.push(performance.now() - jsStart);
      const queryStart = performance.now();
      const reply = await channel.send({
        type: "query",
        requestId: ++requestId,
        query: {
          generation,
          revision: 0,
          filter,
          scope: null,
          risk: null,
          order: "discovery",
          offset,
          limit: 128,
          now,
        },
      });
      nativeMs.push(performance.now() - queryStart);
      assert.equal(reply.type, "page", reply.message);
      assert.equal(reply.requestId, requestId);
      const page = reply.page!;
      assert.equal(page.generation, generation);
      assert.equal(page.revision, 0);
      assert.equal(page.matchingCount, matching.length);
      assert.equal(page.summary.selectedCount, selectedIds.size, "paging cannot change selection");
      assert.deepEqual(page.candidates, expected, `page parity: ${filter} at ${offset}`);
      assert.equal(
        page.nextOffset,
        offset + expected.length < matching.length ? offset + expected.length : null,
      );
      assert.equal(
        page.matchingBytes,
        matching.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
      );
      assert.equal(
        page.matchingBytesPartial,
        matching.some((candidate) => candidate.bytesKnown === false),
      );
    }
    let nativePeakRssBytes: number | null = null;
    if (process.platform === "linux") {
      const status = await readFile(`/proc/${channel.child.pid}/status`, "utf8");
      const kib = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status)?.[1];
      if (kib) nativePeakRssBytes = Number(kib) * 1024;
    }
    const closed = await channel.send({ type: "close", requestId: ++requestId });
    assert.equal(closed.type, "index_closed");
    channel.child.stdin.end();
    assert.equal(await channel.exit, 0);
    results.push({
      count,
      initBytes,
      initMs,
      retainedChargeBytes: ready.summary!.retainedBytes,
      nativePeakRssBytes,
      maxReplyBytes: channel.maxReplyBytes,
      nativeRoundTrip: latency(nativeMs),
      jsFilterAndSlice: latency(jsMs),
    });
  } finally {
    channel.close();
  }
}

const report = JSON.stringify(
  {
    date: new Date().toISOString(),
    runtime: Bun.version,
    platform: process.platform,
    arch: process.arch,
    binary,
    binarySha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    sourceBase: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceDirty:
      execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    rustc: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
    method:
      "Read-only synthetic metadata, 5k/50k/100k records, 200 sequential discovery-order queries per child. Every returned record and aggregate is compared with JS filtering; 50 explicit selected IDs remain queued across paging. Native timings include NDJSON transport and page decoding; JS timings cover filter and slice, without rendering or transport. Native VmHWM includes snapshot parsing/build peak. These are different costs, not an end-to-end engine speed ratio. Host retains the reference snapshot; total UI memory and real-tree scan/delete are not qualified.",
    results,
  },
  null,
  2,
);
if (output) await writeFile(output, `${report}\n`);
console.log(report);
