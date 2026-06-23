import { afterEach, describe, expect, test } from "bun:test";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SweepApp, type SweepUiOutcome } from "./app.js";

function createPlan(): ScanPlan {
  return {
    protocolVersion: "1",
    targetDir: "/tmp/sweep-ui",
    selectionPolicy: { mode: "default", includeDangerous: false },
    candidates: [
      {
        id: "cand_safe",
        path: "/tmp/sweep-ui/node_modules",
        name: "node_modules",
        kind: "node_modules",
        estimatedBytes: 1024,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: true,
      },
      {
        id: "cand_caution",
        path: "/tmp/sweep-ui/dist",
        name: "dist",
        kind: "build",
        estimatedBytes: 4096,
        isSymlink: false,
        entryType: "directory",
        riskTier: "caution",
        reasons: ["build-output"],
        selectedByDefault: false,
      },
    ],
    summary: {
      candidateCount: 2,
      estimatedTotalBytes: 5120,
      scannedDirs: 3,
      exact: false,
      selectedCount: 1,
      riskCounts: { safe: 1, caution: 1, dangerous: 0, blocked: 0 },
    },
    selectedCandidateIds: ["cand_safe"],
    createdAt: new Date().toISOString(),
  };
}

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
});

async function mount(onDone: (outcome: SweepUiOutcome) => void) {
  const setup = await testRender(<SweepApp plan={createPlan()} onDone={onDone} />, {
    width: 120,
    height: 32,
  });
  teardown = () => setup.renderer.destroy();
  await act(async () => {
    await setup.renderOnce();
  });
  return setup;
}

describe("sweep TUI render", () => {
  test("draws header, summary, risk filter, and footer chrome", async () => {
    const setup = await mount(() => {});
    const frame = setup.captureCharFrame();

    expect(frame.length).toBeGreaterThan(0);
    expect(frame).toContain("sweep");
    expect(frame).toContain("visible");
    expect(frame).toContain("risk filter");
    expect(frame).toContain("apply");
  });

  test("q aborts and reports the abort outcome", async () => {
    const outcomes: SweepUiOutcome[] = [];
    const setup = await mount((result) => {
      outcomes.push(result);
    });

    await act(async () => {
      setup.mockInput.pressKey("q");
      await setup.flush();
    });

    expect(outcomes).toEqual([{ type: "abort" }]);
  });

  test("select-all then enter applies all visible candidates", async () => {
    const outcomes: SweepUiOutcome[] = [];
    const setup = await mount((result) => {
      outcomes.push(result);
    });

    await act(async () => {
      setup.mockInput.pressKey("a");
      await setup.flush();
    });
    await act(async () => {
      setup.mockInput.pressEnter();
      await setup.flush();
    });

    const outcome = outcomes[0];
    expect(outcome?.type).toBe("apply");
    if (outcome?.type === "apply") {
      expect(outcome.plan.selectedCandidateIds).toContain("cand_safe");
      expect(outcome.plan.selectedCandidateIds).toContain("cand_caution");
    }
  });
});
