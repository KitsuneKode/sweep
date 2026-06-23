import type { ScanPlan } from "@kitsunekode/sweep-protocol";

export type SweepUiOutcome =
  | { type: "apply"; plan: ScanPlan }
  | { type: "rescan"; disabledPatterns: string[]; extraPatterns: string[] }
  | { type: "abort" };
