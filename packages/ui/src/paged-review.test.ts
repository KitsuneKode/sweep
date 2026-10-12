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
