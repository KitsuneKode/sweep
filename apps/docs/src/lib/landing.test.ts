import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IDLE_REPORT, formatBinaryBytes } from "@/components/landing/content";

describe("landing page claims and arithmetic", () => {
  test("illustrative idle report totals add up from row bytes", () => {
    const unselectedBytes = IDLE_REPORT.rows
      .filter((row) => !row.picked)
      .reduce((sum, row) => sum + row.bytes, 0);

    expect(IDLE_REPORT.selectedBytes + unselectedBytes).toBe(IDLE_REPORT.foundBytes);
    expect(IDLE_REPORT.projectedFreeBytes).toBe(
      IDLE_REPORT.diskFreeBytes + IDLE_REPORT.selectedBytes,
    );
    expect(IDLE_REPORT.selectedCount).toBe(3);
    expect(IDLE_REPORT.rows).toHaveLength(4);
    expect(formatBinaryBytes(IDLE_REPORT.selectedBytes)).toBe("3.3 GiB");
    expect(formatBinaryBytes(IDLE_REPORT.foundBytes)).toBe("4.4 GiB");
    expect(formatBinaryBytes(IDLE_REPORT.todayBytes)).toBe("1.1 GiB");
    expect(formatBinaryBytes(IDLE_REPORT.diskFreeBytes)).toBe("9.6 GiB");
    expect(formatBinaryBytes(IDLE_REPORT.projectedFreeBytes)).toBe("12.9 GiB");
  });

  test("hero commands offer bunx for UI and npx --dry-run for Node, never npx sweep ui", () => {
    const source = readFileSync(join(import.meta.dir, "../components/landing/landing.tsx"), "utf8");
    expect(source).not.toContain("npx @kitsunekode/sweep ui");
    expect(source).toContain("bunx @kitsunekode/sweep ui .");
    expect(source).toContain("npx @kitsunekode/sweep --dry-run .");
  });
});
