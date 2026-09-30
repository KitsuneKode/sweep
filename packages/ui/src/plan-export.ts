import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** `sweep-plan-20260930-141503.json`, local time, sortable, no characters a shell must quote. */
export function planExportName(when: Date): string {
  const date = `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}`;
  const time = `${two(when.getHours())}${two(when.getMinutes())}${two(when.getSeconds())}`;
  return `sweep-plan-${date}-${time}.json`;
}

/**
 * Write the reviewed plan next to where the user launched sweep, ready for
 * `sweep apply --plan <file>`. Never overwrites (`wx`) and is owner-only,
 * since a plan lists paths the user chose to delete.
 */
export function writePlanExport(plan: ScanPlan, directory: string, when = new Date()): string {
  const target = join(directory, planExportName(when));
  writeFileSync(target, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return target;
}
