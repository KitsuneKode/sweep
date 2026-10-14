import { afterEach, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyReport, ScanPlan } from "@kitsunekode/sweep-protocol";
import { DiscoveryIndexSession } from "@kitsunekode/sweep-core/discovery-index";
import { isRustEngineAvailable } from "@kitsunekode/sweep-core/rust-engine";
import { PagedReviewSession } from "./paged-review.js";

const available = isRustEngineAvailable();
if (process.env.SWEEP_REQUIRE_RUST_TESTS === "1" && !available)
  throw new Error("Native paged-review tests require a built engine");
const owners: PagedReviewSession[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
});

function snapshot(count = 600): ScanPlan {
  const targetDir = join(tmpdir(), "sweep-paged-review-synthetic");
  const candidates: ScanPlan["candidates"] = Array.from({ length: count }, (_, i) => ({
    id: `cand_paged_${i}`,
    path: join(targetDir, `project-${i}`, "node_modules"),
    name: "node_modules",
    kind: "node_modules",
    riskTier: i === count - 1 ? "blocked" : "safe",
    estimatedBytes: i + 100,
    bytesKnown: i !== 1,
    isSymlink: false,
    entryType: "directory",
    selectedByDefault: false,
    reasons: ["default-pattern"],
  }));
  return {
    protocolVersion: "1",
    targetDir,
    candidates,
    selectedCandidateIds: candidates.slice(0, Math.min(count - 1, 3)).map((row) => row.id),
    selectionPolicy: { mode: "default", includeDangerous: false },
    createdAt: "2026-10-12T00:00:00.000Z",
    summary: {
      candidateCount: count,
      estimatedTotalBytes: candidates.reduce((sum, row) => sum + row.estimatedBytes, 0),
      scannedDirs: count,
      selectedCount: Math.min(count - 1, 3),
      exact: false,
      riskCounts: { safe: count - 1, caution: 0, dangerous: 0, blocked: 1 },
    },
  };
}
async function open(plan = snapshot()) {
  const index = await DiscoveryIndexSession.open(plan);
  const owner = new PagedReviewSession(index);
  owners.push(owner);
  return { owner, index };
}
function report(plan: ScanPlan, statuses: NonNullable<ApplyReport["outcomes"]>): ApplyReport {
  const byId = new Map(plan.candidates.map((row) => [row.id, row]));
  return {
    protocolVersion: "1",
    targetDir: plan.targetDir,
    selectedCandidateIds: [...plan.selectedCandidateIds],
    outcomes: statuses,
    deletedCount: statuses.filter((row) => row.status === "deleted").length,
    failedCount: statuses.filter((row) => row.status === "failed").length,
    totalBytesFreed: statuses
      .filter((row) => row.status === "deleted")
      .reduce((sum, row) => sum + byId.get(row.candidateId)!.estimatedBytes, 0),
    failedPaths: statuses
      .filter((row) => row.status === "failed")
      .map((row) => ({
        path: byId.get(row.candidateId)!.path,
        code: "busy",
        error: "Owned synthetic refusal",
      })),
  };
}
async function reject(promise: Promise<unknown>) {
  const error: unknown = await promise.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  return error;
}

test.skipIf(!available)(
  "page eviction never loses hidden queue totals or widens a single-item plan",
  async () => {
    const source = snapshot();
    const { owner } = await open(source);
    await owner.load({ offset: 0, limit: 2 });
    expect(owner.view.queuedCandidateIds).toEqual(source.selectedCandidateIds.slice(0, 2));
    expect(owner.view.summary.selectedCount).toBe(3);
    expect(owner.view.summary.selectedBytesPartial).toBe(true);
    const first = owner.view.page;
    await owner.load({ offset: 500, limit: 2 });
    expect(owner.view.queuedCandidateIds).toEqual([]);
    expect(owner.view.page?.candidates).toHaveLength(2);
    expect(owner.view.summary.selectedCount).toBe(3);
    expect(first?.candidates[0]!.id).toBe(source.candidates[0]!.id);
    const single = owner.prepareSingle(source.candidates[500]!.id);
    expect(single.candidates).toHaveLength(1);
    expect(single.selectedCandidateIds).toEqual([source.candidates[500]!.id]);
    expect(owner.view.summary.selectedCount).toBe(3);
    const queue = await owner.prepareQueue();
    expect(queue.selectedCandidateIds).toEqual(source.selectedCandidateIds);
    expect(() => owner.prepareSingle(source.candidates[0]!.id)).toThrow();
    await owner.select([source.candidates[500]!.id], true);
    expect(owner.view.page).toBeNull();
    expect(owner.view.summary.selectedCount).toBe(4);
    expect(owner.view.summary.selectedRiskCounts.safe).toBe(4);
    await owner.load({ offset: 500, limit: 2 });
    expect(owner.view.queuedCandidateIds).toEqual([source.candidates[500]!.id]);
  },
);

test.skipIf(!available)(
  "interrupted apply retires only confirmed rows and preserves failed and unattempted queue",
  async () => {
    const { owner } = await open();
    const plan = await owner.prepareQueue();
    const ids = plan.selectedCandidateIds;
    const receipt = report(plan, [
      { candidateId: ids[0]!, status: "deleted" },
      { candidateId: ids[1]!, status: "failed" },
      { candidateId: ids[2]!, status: "unattempted" },
    ]);
    receipt.interrupted = true;
    const wrongFailure = {
      ...receipt,
      failedPaths: [{ ...receipt.failedPaths[0]!, path: plan.candidates[0]!.path }],
    };
    await reject(owner.reconcile(plan, wrongFailure));
    expect(owner.view.summary.selectedCount).toBe(3);
    await owner.reconcile(plan, receipt);
    expect(owner.view.summary.candidateCount).toBe(599);
    expect(owner.view.summary.selectedCount).toBe(2);
    expect(owner.view.summary.selectedBytesPartial).toBe(true);
    expect(owner.lastReceipt).toEqual({
      deletedCount: 1,
      failedCount: 1,
      coveredCount: 0,
      unattemptedCount: 1,
    });
    expect((await owner.prepareQueue()).selectedCandidateIds).toEqual(ids.slice(1));
    await owner.load({ offset: 0, limit: 2 });
    expect(owner.view.page?.candidates[0]!.id).toBe(ids[1]);
    const single = owner.prepareSingle(ids[1]!);
    await owner.reconcile(single, report(single, [{ candidateId: ids[1]!, status: "deleted" }]));
    expect(owner.view.summary.selectedCount).toBe(1);
    expect(owner.view.summary.bytesPartial).toBe(false);
    expect(owner.view.summary.selectedBytesPartial).toBe(false);
    await reject(owner.reconcile(single, receipt));
    expect(owner.view.summary.selectedCount).toBe(1);
  },
);

test.skipIf(!available)(
  "malformed and unknown receipts cannot retire or clear any queue",
  async () => {
    const { owner } = await open();
    const plan = await owner.prepareQueue();
    const valid = report(
      plan,
      plan.selectedCandidateIds.map((candidateId) => ({ candidateId, status: "deleted" })),
    );
    const before = owner.view.summary;
    for (const invalid of [
      { ...valid, outcomes: undefined },
      { ...valid, targetDir: join(tmpdir(), "another-root") },
      { ...valid, selectedCandidateIds: valid.selectedCandidateIds.slice(1) },
      { ...valid, outcomes: valid.outcomes!.slice(1) },
      { ...valid, deletedCount: 0 },
      { ...valid, totalBytesFreed: 0 },
      {
        ...valid,
        outcomes: valid.outcomes!.map((row) => ({
          ...row,
          status: "covered",
          coveredBy: "missing",
        })),
      },
    ]) {
      await reject(owner.reconcile(plan, invalid as ApplyReport));
      expect(owner.view.summary).toEqual(before);
      expect(owner.lastReceipt).toBeNull();
    }
    const poisoned = structuredClone(plan);
    poisoned.candidates[0]!.path = join(plan.targetDir, "unreviewed", "node_modules");
    await reject(owner.reconcile(poisoned, valid));
    expect(owner.view.summary).toEqual(before);
  },
);

test.skipIf(!available)(
  "multi-page outcome accounting preserves the remainder and bounded pages",
  async () => {
    const source = snapshot();
    source.selectedCandidateIds = source.candidates.slice(0, 599).map((row) => row.id);
    source.summary.selectedCount = 599;
    const { owner } = await open(source);
    const plan = await owner.prepareQueue();
    const outcomes = plan.selectedCandidateIds.map((candidateId, i) => ({
      candidateId,
      status: i < 530 ? ("deleted" as const) : ("unattempted" as const),
    }));
    await owner.reconcile(plan, report(plan, outcomes));
    expect(owner.view.summary.candidateCount).toBe(70);
    expect(owner.view.summary.selectedCount).toBe(69);
    expect((await owner.prepareQueue()).selectedCandidateIds).toEqual(
      plan.selectedCandidateIds.slice(530),
    );
    await owner.load({ limit: 256 });
    expect(owner.view.page?.candidates).toHaveLength(70);
    expect(owner.view.summary.selectedRiskCounts.safe).toBe(69);
  },
);

test.skipIf(!available)(
  "close cancels an outstanding page and releases candidate references",
  async () => {
    const { owner, index } = await open();
    await owner.load({ limit: 1 });
    const pending = owner.load({ offset: 500 });
    expect(owner.view.busy).toBe(true);
    expect(owner.view.page).toBeNull();
    expect(() => owner.prepareSingle("cand_paged_0")).toThrow();
    await reject(owner.select(["cand_paged_0"], false));
    const result = pending.catch((error: unknown) => error);
    await owner.close();
    expect(await result).toBeInstanceOf(Error);
    expect(() => owner.view).toThrow();
    expect(index.diagnostics.retainedWitnessCount).toBe(0);
  },
);

test.skipIf(!available)(
  "an unqueued single-row receipt leaves the entire queue intact",
  async () => {
    const { owner } = await open();
    await owner.load({ offset: 500, limit: 1 });
    const single = owner.prepareSingle("cand_paged_500");
    const queued = (await owner.prepareQueue()).selectedCandidateIds;
    await owner.reconcile(
      single,
      report(single, [{ candidateId: "cand_paged_500", status: "deleted" }]),
    );
    expect(owner.view.summary.candidateCount).toBe(599);
    expect(owner.view.summary.selectedCount).toBe(3);
    expect((await owner.prepareQueue()).selectedCandidateIds).toEqual(queued);
    expect(() => owner.prepareSingle("cand_paged_500")).toThrow();
    await owner.load({ offset: 500, limit: 1 });
    expect(owner.view.page?.candidates[0]!.id).toBe("cand_paged_501");
  },
);

test.skipIf(!available)(
  "a later metadata failure preserves the disk receipt and closes the incomplete review",
  async () => {
    const source = snapshot();
    source.selectedCandidateIds = source.candidates.slice(0, 599).map((row) => row.id);
    source.summary.selectedCount = 599;
    const { owner, index } = await open(source);
    const plan = await owner.prepareQueue();
    const value = report(
      plan,
      plan.selectedCandidateIds.map((candidateId) => ({ candidateId, status: "deleted" })),
    );
    const retire = index.retire.bind(index);
    let batches = 0;
    const injected = spyOn(index, "retire").mockImplementation(async (ids) => {
      if (++batches === 2) throw new Error("Injected index transport loss");
      return await retire(ids);
    });
    try {
      await reject(owner.reconcile(plan, value));
      expect(batches).toBe(2);
      expect(owner.lastReceipt).toEqual({
        deletedCount: 599,
        failedCount: 0,
        coveredCount: 0,
        unattemptedCount: 0,
      });
      expect(() => owner.view).toThrow();
      expect(index.diagnostics.retainedWitnessCount).toBe(0);
      await reject(owner.prepareQueue());
    } finally {
      injected.mockRestore();
    }
  },
);

test.skipIf(!available)(
  "covered children retire with their confirmed parent without counting another deletion",
  async () => {
    const source = snapshot(4);
    source.candidates[1]!.path = join(source.candidates[0]!.path, "nested", "node_modules");
    const { owner } = await open(source);
    const plan = await owner.prepareQueue();
    const ids = plan.selectedCandidateIds;
    await owner.reconcile(
      plan,
      report(plan, [
        { candidateId: ids[0]!, status: "deleted" },
        { candidateId: ids[1]!, status: "covered", coveredBy: ids[0]! },
        { candidateId: ids[2]!, status: "unattempted" },
      ]),
    );
    expect(owner.view.summary.candidateCount).toBe(2);
    expect(owner.view.summary.selectedCount).toBe(1);
    expect(owner.view.summary.bytesPartial).toBe(false);
    expect(owner.lastReceipt).toEqual({
      deletedCount: 1,
      coveredCount: 1,
      failedCount: 0,
      unattemptedCount: 1,
    });
    expect((await owner.prepareQueue()).selectedCandidateIds).toEqual([ids[2]!]);
  },
);

test.skipIf(!available)(
  "nested scopes use one separator namespace and never include prefix siblings",
  async () => {
    const source = snapshot(4);
    source.candidates[0]!.path = join(source.targetDir, "a", "b", "node_modules");
    source.candidates[1]!.path = join(source.targetDir, "a", "c", "node_modules");
    source.candidates[2]!.path = join(source.targetDir, "ab", "node_modules");
    const { owner } = await open(source);
    await owner.load({ scope: "a" });
    expect(owner.view.page?.candidates.map((row) => row.id)).toEqual(
      source.selectedCandidateIds.slice(0, 2),
    );
    expect(owner.view.summary.selectedCount).toBe(3);
    await owner.load({ scope: "a/b" });
    expect(owner.view.page?.candidates.map((row) => row.id)).toEqual([source.candidates[0]!.id]);
    expect(owner.view.queuedCandidateIds).toEqual([source.candidates[0]!.id]);
    if (process.platform === "win32") {
      await owner.load({ scope: "a\\b" });
      expect(owner.view.page?.candidates[0]!.id).toBe(source.candidates[0]!.id);
    }
    await owner.load({ scope: "ab" });
    expect(owner.view.page?.candidates.map((row) => row.id)).toEqual([source.candidates[2]!.id]);
  },
);

test.skipIf(!available || process.platform === "win32")(
  "POSIX backslash names do not become nested scope keys",
  async () => {
    const source = snapshot(4);
    source.candidates[0]!.path = join(source.targetDir, "a\\b", "node_modules");
    source.candidates[1]!.path = join(source.targetDir, "a", "b", "node_modules");
    const { owner } = await open(source);
    await owner.load({ scope: "a\\b" });
    expect(owner.view.page?.candidates.map((row) => row.id)).toEqual([source.candidates[0]!.id]);
    await owner.load({ scope: "a/b" });
    expect(owner.view.page?.candidates.map((row) => row.id)).toEqual([source.candidates[1]!.id]);
  },
);

test.skipIf(!available)(
  "closing after export but before delivery cannot return a fresh apply plan",
  async () => {
    const { owner, index } = await open();
    const snapshot = index.snapshot.bind(index);
    const delayed = spyOn(index, "snapshot").mockImplementation(async (mode) => {
      const plan = await snapshot(mode);
      await owner.close();
      return plan;
    });
    try {
      expect(await reject(owner.prepareQueue())).toMatchObject({ code: "discovery_closed" });
      expect(index.diagnostics.retainedWitnessCount).toBe(0);
      expect(owner.lastReceipt).toBeNull();
    } finally {
      delayed.mockRestore();
    }
  },
);

test.skipIf(!available)(
  "scope actions include hidden rows, distinguish root and exclude prefix siblings",
  async () => {
    const source = snapshot(600);
    source.selectedCandidateIds = [];
    source.summary.selectedCount = 0;
    for (let i = 0; i < source.candidates.length; i++) {
      const row = source.candidates[i]!;
      row.path = join(
        source.targetDir,
        i === 0 ? "" : i < 500 ? "a/nested" : "ab",
        `node_modules-${i}`,
      );
      row.riskTier =
        i === 599 ? "blocked" : i === 598 ? "dangerous" : i === 597 ? "caution" : "safe";
    }
    source.summary.riskCounts = { safe: 597, caution: 1, dangerous: 1, blocked: 1 };
    const { owner } = await open(source);
    await owner.load({ limit: 1 });
    expect((await owner.scopeSummary("a")).candidateCount).toBe(499);
    expect((await owner.scopeSummary("")).candidateCount).toBe(1);
    expect((await owner.scopeSummary(null)).candidateCount).toBe(600);
    await owner.load({ scope: "", limit: 1 });
    expect(owner.view.page?.matchingCount).toBe(1);
    expect(owner.view.page?.candidates[0]!.id).toBe(source.candidates[0]!.id);
    await owner.load({ scope: "a", limit: 1 });
    expect(owner.view.page?.matchingCount).toBe(499);
    await owner.selectScope("a", true);
    expect(owner.view.page).toBeNull();
    expect(owner.view.summary.selectedCount).toBe(499);
    expect((await owner.scopeSummary("ab")).selectedCount).toBe(0);
    await owner.selectScope(null, true);
    expect(owner.view.summary.selectedCount).toBe(598);
    expect(owner.view.summary.selectedRiskCounts).toEqual({
      safe: 597,
      caution: 1,
      dangerous: 0,
      blocked: 0,
    });
    const revision = owner.view.summary.revision;
    await owner.selectScope(null, true);
    expect(owner.view.summary.revision).toBe(revision);
    await owner.selectScope("ab", true, true);
    expect(owner.view.summary.selectedCount).toBe(599);
    expect((await owner.prepareQueue()).selectedCandidateIds).toHaveLength(599);
    await owner.selectScope("a", false);
    expect(owner.view.summary.selectedCount).toBe(100);
    expect(owner.view.summary.selectedBytesPartial).toBe(false);
    const before = owner.view.summary;
    await expect(owner.selectScope("a/", true)).rejects.toMatchObject({
      code: "discovery_refused",
    });
    expect(owner.view.summary).toEqual(before);
    await owner.selectScope(null, false);
    expect(owner.view.summary.selectedCount).toBe(0);
    expect(owner.view.summary.selectedBytes).toBe(0);
    expect((await owner.scopeSummary("ab")).selectedCount).toBe(0);
  },
);

test.skipIf(!available)(
  "scope separators preserve literal POSIX names and normalize Windows keys",
  async () => {
    const source = snapshot(3);
    source.selectedCandidateIds = [];
    source.summary.selectedCount = 0;
    source.candidates[0]!.path = join(source.targetDir, "東京😀", "nested", "node_modules");
    source.candidates[1]!.path = join(source.targetDir, "東京😀\\nested", "node_modules");
    source.candidates[2]!.path = join(source.targetDir, "東京😀x", "node_modules");
    const { owner } = await open(source);
    expect((await owner.scopeSummary("東京😀")).candidateCount).toBe(
      process.platform === "win32" ? 2 : 1,
    );
    expect((await owner.scopeSummary("東京😀\\nested")).candidateCount).toBe(
      process.platform === "win32" ? 2 : 1,
    );
    expect((await owner.scopeSummary("東京😀/nested")).candidateCount).toBe(
      process.platform === "win32" ? 2 : 1,
    );
    await owner.selectScope("東京😀", true);
    expect(owner.view.summary.selectedCount).toBe(process.platform === "win32" ? 2 : 1);
    expect((await owner.scopeSummary("東京😀x")).selectedCount).toBe(0);
  },
);

test.skipIf(!available)(
  "folder pages carry descendant totals without exposing the whole candidate graph",
  async () => {
    const source = snapshot(600);
    for (let i = 0; i < 600; i++)
      source.candidates[i]!.path = join(
        source.targetDir,
        i === 0 ? "" : i < 300 ? "a/b" : "ab",
        `node_modules-${i}`,
      );
    const { owner } = await open(source);
    const top = await owner.folders(null, 0, 1);
    expect(top.folders).toHaveLength(1);
    expect(top.matchingCount).toBe(3);
    expect(top.nextOffset).toBe(1);
    expect(top.folders[0]!.key).toBe("ab");
    expect(top.folders[0]!.totals.candidateCount).toBe(300);
    const second = await owner.folders(null, 1, 1);
    expect(second.folders[0]!.key).toBe("a");
    expect(second.folders[0]!.ownCount).toBe(0);
    expect(second.folders[0]!.hasChildren).toBe(true);
    expect(second.folders[0]!.totals.selectedCount).toBe(2);
    expect(second.folders[0]!.totals.bytesPartial).toBe(true);
    expect(owner.view.folderPage).toBe(second);
    const nested = await owner.folders("a");
    expect(nested.folders.map((row) => row.key)).toEqual(["a/b"]);
    expect(nested.folders[0]!.ownCount).toBe(299);
    expect((await owner.folders("")).folders).toEqual([]);
    expect((await owner.folders("a/b")).folders).toEqual([]);
    const root = await owner.folders(null, 2, 1);
    expect(root.folders[0]!.key).toBe("");
    expect(root.folders[0]!.totals.selectedCount).toBe(1);
    const reviewed = await owner.prepareQueue();
    await owner.reconcile(
      reviewed,
      report(
        reviewed,
        reviewed.selectedCandidateIds.map((candidateId) => ({ candidateId, status: "deleted" })),
      ),
    );
    expect(owner.view.folderPage).toBeNull();
    const after = await owner.folders("a");
    expect(after.folders[0]!.totals.candidateCount).toBe(297);
    expect(after.folders[0]!.totals.selectedCount).toBe(0);
    expect(after.folders[0]!.totals.bytesPartial).toBe(false);
  },
);
