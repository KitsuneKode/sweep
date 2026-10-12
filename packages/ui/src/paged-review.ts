import {
  DiscoveryIndexError,
  DiscoveryIndexSession,
  type DiscoveryPage,
  type DiscoveryQuery,
  type DiscoverySummary,
} from "@kitsunekode/sweep-core/discovery-index";
import { validateApplyReport } from "@kitsunekode/sweep-core/plan";
import type { ApplyReport, ScanPlan } from "@kitsunekode/sweep-protocol";

export interface PagedReviewView {
  readonly summary: DiscoverySummary;
  readonly page: DiscoveryPage | null;
  /** Only the current page's queue marks; this is never the global apply selection. */
  readonly queuedCandidateIds: readonly string[];
  readonly busy: boolean;
}

export interface PagedApplyReceipt {
  readonly deletedCount: number;
  readonly failedCount: number;
  readonly coveredCount: number;
  readonly unattemptedCount: number;
}

/** One complete review generation with one retained page. Global queue authority
 * stays in the validated native session. Takes exclusive ownership of that session;
 * callers must not operate it separately. This owner never invokes an apply engine. */
export class PagedReviewSession {
  private page: DiscoveryPage | null = null;
  private busy = false;
  private closed = false;
  private receipt: PagedApplyReceipt | null = null;

  constructor(private readonly index: DiscoveryIndexSession) {}

  get view(): PagedReviewView {
    this.assertOpen();
    return Object.freeze({
      summary: this.index.summary,
      page: this.page,
      busy: this.busy,
      queuedCandidateIds: Object.freeze(
        this.page?.candidates
          .filter((candidate) => this.index.isSelected(candidate.id))
          .map((candidate) => candidate.id) ?? [],
      ),
    });
  }

  /** Known filesystem outcomes survive a later review-index failure. */
  get lastReceipt(): PagedApplyReceipt | null {
    return this.receipt;
  }

  private assertOpen(): void {
    if (this.closed)
      throw new DiscoveryIndexError(
        "discovery_closed",
        "Review generation is closed; rescan before applying",
      );
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.busy)
      throw new DiscoveryIndexError("discovery_busy", "A review request is already running");
    this.busy = true;
    try {
      const result = await operation();
      // A terminal close or native failure may land after the last reply but
      // before the operation's caller resumes. Never deliver a fresh plan then.
      this.assertOpen();
      this.index.summary;
      return result;
    } catch (error) {
      // A native protocol/transport failure poisons the generation. Release its
      // page too; ordinary local refusals keep the last verified review usable.
      try {
        this.index.summary;
      } catch {
        await this.close();
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async load(query: DiscoveryQuery = {}): Promise<PagedReviewView> {
    await this.run(async () => {
      // Never leave a previous filter/scope looking actionable during its replacement.
      this.page = null;
      const page = await this.index.query({
        ...query,
        now: query.now ?? Math.floor(Date.now() / 60_000) * 60_000,
      });
      this.assertOpen();
      this.page = page;
    });
    return this.view;
  }

  async select(ids: readonly string[], selected: boolean): Promise<PagedReviewView> {
    await this.run(async () => {
      await this.index.select(ids, selected);
      this.page = null; // is:queued filters, row selection and totals need a fresh revision.
    });
    return this.view;
  }

  async prepareQueue(): Promise<ScanPlan> {
    return this.run(() => this.index.snapshot());
  }

  prepareSingle(id: string): ScanPlan {
    this.assertOpen();
    if (this.busy || !this.page || this.page.revision !== this.index.summary.revision)
      throw new DiscoveryIndexError(
        "discovery_refused",
        "Load the current row before reviewing it",
      );
    const candidate = this.page.candidates.find((row) => row.id === id);
    if (!candidate)
      throw new DiscoveryIndexError("discovery_refused", "Candidate is not in the current page");
    return this.index.planForCandidate(candidate);
  }

  /** Apply is owned elsewhere. Only a complete authoritative outcome partition
   * can retire rows here; cancellation keeps failed/unattempted rows and their queue. */
  async reconcile(plan: ScanPlan, value: ApplyReport): Promise<PagedReviewView> {
    await this.run(async () => {
      this.index.assertReviewedPlan(plan);
      const report = validateApplyReport(value);
      const selected = new Set(plan.selectedCandidateIds);
      const outcomes = report.outcomes;
      const ids = new Set(outcomes?.map((outcome) => outcome.candidateId));
      const deleted = new Set(
        outcomes
          ?.filter((outcome) => outcome.status === "deleted")
          .map((outcome) => outcome.candidateId),
      );
      const byId = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
      const failed = outcomes?.filter((outcome) => outcome.status === "failed") ?? [];
      if (
        !outcomes ||
        report.targetDir !== plan.targetDir ||
        new Set(report.selectedCandidateIds).size !== selected.size ||
        report.selectedCandidateIds.length !== selected.size ||
        report.selectedCandidateIds.some((id) => !selected.has(id)) ||
        ids.size !== outcomes.length ||
        ids.size !== selected.size ||
        [...ids].some((id) => !selected.has(id)) ||
        report.deletedCount !== deleted.size ||
        report.failedCount !== failed.length ||
        report.failedPaths.length !== failed.length ||
        report.totalBytesFreed !==
          [...deleted].reduce((sum, id) => sum + byId.get(id)!.estimatedBytes, 0) ||
        outcomes.some((outcome) =>
          outcome.status === "covered"
            ? !outcome.coveredBy || !deleted.has(outcome.coveredBy)
            : outcome.coveredBy !== undefined,
        )
      )
        throw new DiscoveryIndexError(
          "discovery_refused",
          "Incomplete or inconsistent apply receipt; no rows retired",
        );
      const failurePaths = new Map<string, number>();
      for (const outcome of failed) {
        const path = byId.get(outcome.candidateId)!.path;
        failurePaths.set(path, (failurePaths.get(path) ?? 0) + 1);
      }
      for (const failure of report.failedPaths) {
        const count = failurePaths.get(failure.path) ?? 0;
        if (count === 0)
          throw new DiscoveryIndexError(
            "discovery_refused",
            "Failure paths do not match the reviewed outcome partition",
          );
        failurePaths.set(failure.path, count - 1);
      }
      // Detach the bounded ID list before the first asynchronous native request.
      const removed = outcomes
        .filter((outcome) => outcome.status === "deleted" || outcome.status === "covered")
        .map((outcome) => outcome.candidateId);
      this.receipt = Object.freeze({
        deletedCount: deleted.size,
        failedCount: failed.length,
        coveredCount: outcomes.filter((outcome) => outcome.status === "covered").length,
        unattemptedCount: outcomes.filter((outcome) => outcome.status === "unattempted").length,
      });
      this.page = null;
      try {
        for (let offset = 0; offset < removed.length; offset += 256)
          await this.index.retire(removed.slice(offset, offset + 256));
      } catch (error) {
        // A failed later batch cannot pretend that the review generation is complete.
        // The disk receipt remains known; the rows require a new generation.
        await this.close();
        throw error;
      }
    });
    return this.view;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.page = null;
    await this.index.close();
  }
}
