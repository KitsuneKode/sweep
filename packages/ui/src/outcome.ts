import type { ApplyProgress, ApplyReport, ScanPlan } from "@kitsunekode/sweep-protocol";

export type SweepUiOutcome =
  /** `trash`: the user chose "move to trash" in the confirm dialog. */
  | { type: "apply"; plan: ScanPlan; trash?: boolean }
  | { type: "rescan"; disabledPatterns: string[]; extraPatterns: string[] }
  | { type: "abort" }
  | {
      type: "done";
      deletedCount: number;
      movedCount: number;
      failedCount: number;
      unattemptedCount: number;
      interrupted: boolean;
      unknownOutcome: boolean;
    };

/**
 * A scoped apply the app runs without leaving the session (queued or single-row `x`).
 * The plan carries exactly the ids being removed; the engine's revalidation,
 * containment and outcome reporting apply identically to a queued apply.
 */
export interface UiApplyRequest {
  plan: ScanPlan;
  engine: "js" | "rust";
  trash: boolean;
  /** Abort stops scheduling new deletions; in-flight work still finishes. */
  signal: AbortSignal;
  onProgress?: (progress: ApplyProgress) => void;
}

export interface UiApplyResult {
  report: ApplyReport;
  interrupted: boolean;
  /** Absolute trash dir when the apply moved instead of deleting. */
  trashDir?: string;
}

export type UiApplyFn = (request: UiApplyRequest) => Promise<UiApplyResult>;
