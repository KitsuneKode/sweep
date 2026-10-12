/** Read-only synthetic index qualification; never scans or removes filesystem entries. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { DiscoveryIndexSession } from "@kitsunekode/sweep-core/discovery-index";
import { compileFilter } from "../src/filter-query.js";
import { PagedReviewSession } from "../src/paged-review.js";

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

function snapshot(count: number, compactPaths = false): ScanPlan {
  const targetDir = join(tmpdir(), compactPaths ? "si" : "sweep-readonly-index-fixture");
  const candidates: ScanCandidate[] = Array.from({ length: count }, (_, index) => {
    const name = index % 2 ? "target" : "node_modules";
    const isSymlink = index % 13 === 0;
    return {
      id: compactPaths ? index.toString(36) : `cand_index_${index}`,
      path: join(
        targetDir,
        `group-${Math.floor(index / 100)}`,
        `${compactPaths ? index.toString(36) : `project-${index}`}${index % 11 === 0 ? "-東京" : ""}`,
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
for (const { count, compactPaths } of [
  { count: 5000, compactPaths: false },
  { count: 50000, compactPaths: false },
  { count: 100000, compactPaths: false },
  { count: 100000, compactPaths: true },
]) {
  const plan = snapshot(count, compactPaths);
  const selectedIds = new Set(plan.selectedCandidateIds);
  const context = { selectedIds, now };
  const started = performance.now();
  let channel: DiscoveryIndexSession;
  try {
    channel = await DiscoveryIndexSession.open(plan, { command: [binary] });
  } catch (error) {
    if (error instanceof Error && error.name === "ResourceLimitError") {
      results.push({ count, compactPaths, status: "refused_before_spawn", reason: error.message });
      continue;
    }
    throw error;
  }
  const review = new PagedReviewSession(channel);
  try {
    const initBytes = Buffer.byteLength(JSON.stringify(plan)) + 128;
    const initMs = performance.now() - started;
    const ready = channel.summary;
    assert.equal(ready.candidateCount, count);
    assert.equal(ready.selectedCount, selectedIds.size);
    assert.ok(ready.retainedBytes <= 64 * 1024 * 1024);
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
      const page = (await review.load({ filter, offset, limit: 128, now })).page!;
      nativeMs.push(performance.now() - queryStart);
      assert.equal(page.generation, ready.generation);
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
    const scopeStarted = performance.now();
    const scope = await review.scopeSummary("group-2");
    const scopeRows = plan.candidates.filter((row) =>
      row.path.startsWith(
        join(plan.targetDir, "group-2") + (process.platform === "win32" ? "\\" : "/"),
      ),
    );
    assert.equal(scope.candidateCount, scopeRows.length);
    assert.equal(
      scope.estimatedBytes,
      scopeRows.reduce((sum, row) => sum + row.estimatedBytes, 0),
    );
    assert.equal(
      scope.bytesPartial,
      scopeRows.some((row) => row.bytesKnown === false),
    );
    assert.equal((await review.scopeSummary("")).candidateCount, 0);
    const bulkMs = [];
    const eligible = plan.candidates.filter(
      (row) => row.riskTier !== "blocked" && row.riskTier !== "dangerous",
    );
    for (const selected of [false, true, false]) {
      const start = performance.now();
      await review.selectScope(null, selected);
      bulkMs.push(performance.now() - start);
      assert.equal(review.view.summary.selectedCount, selected ? eligible.length : 0);
      assert.equal(
        review.view.summary.selectedBytes,
        selected ? eligible.reduce((sum, row) => sum + row.estimatedBytes, 0) : 0,
      );
      assert.equal(review.view.summary.selectedRiskCounts.blocked, 0);
      assert.equal(
        review.view.summary.selectedBytesPartial,
        selected && eligible.some((row) => row.bytesKnown === false),
      );
      assert.equal(review.view.page, null);
    }
    await review.select([...selectedIds], true);
    assert.equal(review.view.summary.selectedCount, selectedIds.size);
    const scopedActions = {
      scopeRecords: scopeRows.length,
      globalQueueRecords: eligible.length,
      globalClearQueueClearMs: bulkMs,
      totalMs: performance.now() - scopeStarted,
    };
    let nativePeakRssBytes: number | null = null;
    if (process.platform === "linux") {
      const status = await readFile(`/proc/${channel.diagnostics.pid}/status`, "utf8");
      const kib = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status)?.[1];
      if (kib) nativePeakRssBytes = Number(kib) * 1024;
    }
    results.push({
      count,
      compactPaths,
      status: "qualified",
      initBytes,
      initMs,
      retainedChargeBytes: ready.retainedBytes,
      nativePeakRssBytes,
      hostRetainedChargeBytes: channel.diagnostics.hostRetainedChargeBytes,
      maxReplyBytes: channel.diagnostics.maxReplyBytes,
      nativeRoundTrip: latency(nativeMs),
      jsFilterAndSlice: latency(jsMs),
      scopedActions,
    });
  } finally {
    await review.close();
    assert.equal(channel.diagnostics.retainedWitnessCount, 0);
  }
}

const replacements = [];
for (let generation = 0; generation < 3; generation++) {
  const plan = snapshot(50000);
  const baselineFds = process.platform === "linux" ? (await readdir("/proc/self/fd")).length : null;
  const channel = await DiscoveryIndexSession.open(plan, { command: [binary] });
  const review = new PagedReviewSession(channel);
  const pid = channel.diagnostics.pid;
  const farId = plan.candidates[40002]!.id;
  try {
    await review.select([farId], true);
    for (const offset of [0, 128, 40000]) {
      const page = (await review.load({ offset, limit: 128, now })).page!;
      assert.equal(page.summary.selectedCount, 51);
      assert.equal(channel.isSelected(farId), true);
    }
    const exported = await review.prepareQueue();
    assert.deepEqual(
      new Set(exported.selectedCandidateIds),
      new Set([...plan.selectedCandidateIds, farId]),
    );
    assert.equal(exported.candidates.length, 51);
    const removed = new Set(exported.selectedCandidateIds.slice(0, 2));
    await review.reconcile(exported, {
      protocolVersion: "1",
      targetDir: exported.targetDir,
      selectedCandidateIds: [...exported.selectedCandidateIds],
      deletedCount: 2,
      failedCount: 0,
      failedPaths: [],
      totalBytesFreed: exported.candidates
        .filter((candidate) => removed.has(candidate.id))
        .reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
      outcomes: exported.selectedCandidateIds.map((candidateId) => ({
        candidateId,
        status: removed.has(candidateId) ? "deleted" : "unattempted",
      })),
    });
    assert.equal(review.view.summary.candidateCount, 49998);
    assert.equal(review.view.summary.selectedCount, 49);
    assert.equal(review.lastReceipt?.deletedCount, 2);
    const remaining = await review.prepareQueue();
    assert.deepEqual(remaining.selectedCandidateIds, exported.selectedCandidateIds.slice(2));
    assert.equal((await review.load({ limit: 128, now })).page!.candidates.length, 128);
  } finally {
    await review.close();
  }
  const afterFds = process.platform === "linux" ? (await readdir("/proc/self/fd")).length : null;
  assert.equal(channel.diagnostics.retainedWitnessCount, 0);
  assert.equal(channel.diagnostics.hostRetainedChargeBytes, 0);
  if (baselineFds !== null && afterFds !== null)
    assert.ok(afterFds <= baselineFds + 2, "replacement leaked pipe descriptors");
  if (pid) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      alive = false;
    }
    assert.equal(alive, false, "closed read-only child is still alive");
  }
  replacements.push({
    generation,
    records: 50000,
    exportedSelectedCount: 51,
    retiredRows: 2,
    remainingSelectedCount: 49,
    baselineFds,
    afterFds,
    reaped: true,
  });
}

const report = JSON.stringify(
  {
    date: new Date().toISOString(),
    runtime: Bun.version,
    reviewOwner: "PagedReviewSession",
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
      "Read-only synthetic metadata, 5k/50k/100k records, including both normal and compact paths at 100k, 200 sequential discovery-order queries per accepted child. Plan resource refusals are recorded before spawn; no limits are raised. Every returned record and aggregate is compared with JS filtering; 50 explicit selected IDs remain queued across paging. Scoped totals are compared with reference paths; global clear/queue/clear actions verify counts, bytes and partial markers without exporting candidates or ID batches. Bulk timings are individual observations, not percentile qualification. Native timings include the bounded UI page owner, production adapter, NDJSON transport, strict validation and candidate fingerprint checks; JS timings cover filter and slice, without rendering or transport. Native VmHWM includes snapshot parsing/build peak. These are different costs, not an end-to-end engine speed ratio. Three additional 50k generations qualify queue-preserving selected export, synthetic outcome retirement, remaining-queue export, child reaping and descriptor cleanup. Host retains the reference snapshot; total UI memory and real-tree scan/delete are not qualified.",
    results,
    replacements,
  },
  null,
  2,
);
if (output) await writeFile(output, `${report}\n`);
console.log(report);
