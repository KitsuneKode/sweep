import { afterEach, describe, expect, test } from "bun:test";
import type { RiskTier, ScanPlan } from "@kitsunekode/sweep-protocol";
import { t } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  buildLedger,
  buildQueueRule,
  buildReceiptLine,
  displayTarget,
  LedgerBand,
  queueSafeBytes,
  spacedBytes,
} from "./LedgerBand.js";
import { createUiState, getUiSummary, getVisibleCandidates, type SweepUiState } from "./state.js";
import { darkTheme } from "./theme.js";

let teardown: (() => void) | undefined;
afterEach(async () => {
  await act(async () => teardown?.());
  teardown = undefined;
});

function plan(tiers: RiskTier[], bytes: number[] = tiers.map(() => 1024)): ScanPlan {
  const candidates = tiers.map((riskTier, i) => ({
    id: `cand_${i}`,
    path: `/tmp/sweep-ledger/pkg${i}/node_modules`,
    name: "node_modules",
    kind: "node_modules" as const,
    estimatedBytes: bytes[i]!,
    entryType: "directory" as const,
    isSymlink: false,
    riskTier,
    reasons: ["default-pattern"],
    selectedByDefault: false,
  }));
  return {
    protocolVersion: "1",
    targetDir: "/tmp/sweep-ledger",
    candidates,
    selectedCandidateIds: [],
    summary: {
      candidateCount: candidates.length,
      selectedCount: 0,
      estimatedSelectedBytes: 0,
    },
  } as unknown as ScanPlan;
}

async function render(
  state: SweepUiState,
  width = 120,
  onRiskFilter: (tier: RiskTier | "all") => void = () => {},
) {
  const setup = await testRender(
    <LedgerBand
      tokens={darkTheme}
      width={width}
      targetDir={state.targetDir}
      candidates={state.candidates}
      visible={getVisibleCandidates(state)}
      selectedIds={state.selectedIds}
      summary={getUiSummary(state)}
      riskFilter={state.riskFilter}
      scanning={state.scanning}
      incomplete={state.scanIncomplete}
      sizedCount={state.scanSizedCount}
      stats={t`2 found`}
      onMenu={() => {}}
      onQueueSafe={() => {}}
      onReview={() => {}}
      onRiskFilter={onRiskFilter}
    />,
    { width, height: 4 },
  );
  teardown = () => setup.renderer.destroy();
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  return setup;
}

describe("ledger facts", () => {
  test("blocked bytes are found but never reclaimable", () => {
    const ledger = buildLedger(plan(["safe", "caution", "blocked"], [10, 20, 40]).candidates);
    expect(ledger.reclaimable).toBe(30);
    expect(ledger.bytes.blocked).toBe(40);
    expect(ledger.counts).toEqual({ safe: 1, caution: 1, dangerous: 0, blocked: 1 });
  });

  test("queue safe counts only listed safe items that are not queued yet", () => {
    const candidates = plan(["safe", "safe", "caution"], [10, 20, 40]).candidates;
    expect(queueSafeBytes(candidates, new Set(["cand_0"]))).toBe(20);
  });

  test("the queue rule shows any queued byte and never rounds a full queue short", () => {
    const cells = (value: number, total: number) =>
      buildQueueRule(value, total, 10, "#fff", "#000")
        .chunks.map((chunk) => chunk.text)
        .join("");
    expect(cells(1, 1_000_000)).toBe(`━${"─".repeat(9)}`);
    expect(cells(0, 100)).toBe("─".repeat(10));
    expect(cells(100, 100)).toBe("━".repeat(10));
  });

  test("the receipt names what came back and every outcome that did not", () => {
    const line = (receipt: Parameters<typeof buildReceiptLine>[0]) =>
      buildReceiptLine(receipt, darkTheme)
        .chunks.map((chunk) => chunk.text)
        .join("");
    const clean = { removed: 3, failed: 0, unattempted: 0, freedBytes: 2048, trash: false };
    expect(line({ ...clean, stopped: false })).toBe("✓ ~2.0 KiB freed · 3 removed");
    expect(line({ ...clean, trash: true, failed: 1, unattempted: 2, stopped: true })).toBe(
      "✓ ~2.0 KiB moved to trash · 3 removed · 1 failed · 2 unattempted · stopped",
    );
  });

  test("labels read like prose and paths collapse the home directory", () => {
    expect(spacedBytes(62 * 1024 ** 3)).toBe("62 GiB");
    expect(displayTarget("/home/me/Projects", "/home/me")).toBe("~/Projects");
    expect(displayTarget("/home/meadow", "/home/me")).toBe("/home/meadow");
  });
});

describe("ledger band", () => {
  test("queue coverage distinguishes byte percentage from item count, including zero-byte items", async () => {
    const initial = createUiState(plan(["safe", "safe", "safe"], [9900, 100, 0]));
    let setup = await render({ ...initial, selectedIds: new Set(["cand_0"]) });
    expect(setup.captureCharFrame()).toContain("99% of bytes");
    expect(setup.captureCharFrame()).toContain("1 queued");
    setup.renderer.destroy();
    setup = await render({ ...initial, selectedIds: new Set(["cand_2"]) });
    expect(setup.captureCharFrame()).toContain("1 queued");
    expect(setup.captureCharFrame()).not.toContain("nothing queued");
  });

  test("an invalidated review asks for a rescan and does not claim sizes", async () => {
    const setup = await render({ ...createUiState(plan(["safe"])), scanIncomplete: true });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Review incomplete");
    expect(frame).toContain("rescan with r before applying");
    expect(frame).not.toContain("reclaimable");
  });

  test("the tier legend filters by risk and toggles back to all", async () => {
    const calls: Array<RiskTier | "all"> = [];
    const state = createUiState(plan(["safe", "caution"]));
    let setup = await render(state, 120, (tier) => calls.push(tier));
    const click = async (label: string) => {
      const lines = setup.captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes(label));
      expect(y).toBeGreaterThanOrEqual(0);
      await act(async () => {
        await setup.mockMouse.click(lines[y]!.indexOf(label) + 1, y);
        await setup.flush();
      });
    };
    await click("caution");
    expect(calls).toEqual(["caution"]);
    setup.renderer.destroy();
    setup = await render({ ...state, riskFilter: "caution" }, 120, (tier) => calls.push(tier));
    await click("caution");
    expect(calls).toEqual(["caution", "all"]);
  });
});
