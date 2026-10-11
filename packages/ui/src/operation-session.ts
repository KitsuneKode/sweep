import { isApplyRefusedError } from "@kitsunekode/sweep-core/guardrails";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import type { SweepUiOutcome, UiApplyRequest, UiApplyResult } from "./outcome.js";

type Request = Omit<UiApplyRequest, "engine">;
type Done = Extract<SweepUiOutcome, { type: "done" }>;

/** Owns host-validated apply receipts independently of the React view. */
export class UiOperationSession {
  private active: { controller: AbortController; settled: Promise<void> } | undefined;
  private attempted = false;
  private result: Done = {
    type: "done",
    deletedCount: 0,
    movedCount: 0,
    failedCount: 0,
    unattemptedCount: 0,
    interrupted: false,
    unknownOutcome: false,
  };
  private closingState = false;

  get closing(): boolean {
    return this.closingState;
  }

  async run(
    request: Request,
    apply: (request: Request) => Promise<UiApplyResult>,
  ): Promise<UiApplyResult> {
    if (this.active || this.closing)
      throw new Error("The interactive session cannot start another apply");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
    let settle!: () => void;
    this.active = {
      controller,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    try {
      const result = await apply({ ...request, signal: controller.signal });
      // The host has already checked identities, outcome partition and journal.
      // Record the receipt before returning it to a view that may have unmounted.
      this.attempted = true;
      if (result.trashDir) this.result.movedCount += result.report.deletedCount;
      else this.result.deletedCount += result.report.deletedCount;
      this.result.failedCount += result.report.failedCount;
      const unattempted = result.report.outcomes
        ? result.report.outcomes.filter((outcome) => outcome.status === "unattempted").length
        : result.report.interrupted
          ? Math.max(
              0,
              result.report.selectedCandidateIds.length -
                result.report.failedCount -
                result.report.deletedCount,
            )
          : 0;
      this.result.unattemptedCount += unattempted;
      this.result.interrupted ||=
        result.interrupted || result.report.interrupted === true || unattempted > 0;
      return result;
    } catch (error) {
      if (!isApplyRefusedError(error)) {
        this.attempted = true;
        this.result.unknownOutcome = true;
      }
      throw error;
    } finally {
      request.signal.removeEventListener("abort", cancel);
      this.active = undefined;
      settle();
    }
  }

  cancel(): boolean {
    if (!this.active) return false;
    this.active.controller.abort();
    return true;
  }

  viewFailed(error: unknown): void {
    this.result.viewError ??= sanitizeTerminalText(
      error instanceof Error ? error.message : String(error),
    ).slice(0, 4096);
    this.closingState = true;
    this.cancel();
  }

  outcome(requested: SweepUiOutcome): SweepUiOutcome {
    return this.result.viewError ||
      ((requested.type === "abort" || requested.type === "done") && this.attempted)
      ? { ...this.result }
      : requested;
  }

  async close(requested: SweepUiOutcome): Promise<SweepUiOutcome> {
    this.closingState = true;
    const active = this.active;
    active?.controller.abort();
    // The host owns cancellation's watchdog and the recovery journal. A view
    // failure must not sever that path or manufacture an ordinary abort.
    await active?.settled;
    return this.outcome(requested);
  }
}
