import type { ScanPlan } from "@kitsunekode/sweep-protocol";

export type SweepUiOutcome =
  /** `trash`: the user chose "move to trash" in the confirm dialog. */
  | { type: "apply"; plan: ScanPlan; trash?: boolean }
  | { type: "rescan"; disabledPatterns: string[]; extraPatterns: string[] }
  | { type: "abort" };
