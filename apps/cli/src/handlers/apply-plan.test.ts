import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan } from "@kitsunekode/sweep-core/planner";
import { applyReviewedPlan } from "./apply-plan.js";

test("an over-cap preview needs no destructive authorization and preserves the source", async () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-large-preview-"));
  try {
    const artifact = join(root, "node_modules");
    mkdirSync(artifact);
    writeFileSync(join(artifact, "keep"), "owned");
    const bytes = 600 * 1024 ** 3;
    const plan = buildPlan(root, {
      entries: [
        {
          path: artifact,
          name: "node_modules",
          entryType: "directory",
          isSymlink: false,
          estimatedBytes: bytes,
        },
      ],
      estimatedTotalBytes: bytes,
      scannedDirs: 1,
      skippedDirs: 0,
      exact: false,
    });
    const preview = await applyReviewedPlan(plan, { maxSizeGB: 0, dryRun: true, engine: "js" });
    expect(preview.status).toBe("dry_run");
    await expect(applyReviewedPlan(plan, { maxSizeGB: 0, engine: "js" })).rejects.toThrow(
      "Nothing removed",
    );
    expect(readFileSync(join(artifact, "keep"), "utf8")).toBe("owned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
