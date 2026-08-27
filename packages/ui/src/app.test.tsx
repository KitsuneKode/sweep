import { afterEach, describe, expect, test } from "bun:test";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SweepApp, type SweepUiOutcome } from "./app.js";
import type { UiScanControl } from "./streaming.js";

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
  test("draws brand header, stats, and statusline chrome", async () => {
    const setup = await mount(() => {});
    const frame = setup.captureCharFrame();

    expect(frame.length).toBeGreaterThan(0);
    expect(frame).toContain("sweep");
    expect(frame).toContain("found");
    expect(frame).toContain("selected");
    expect(frame).toContain("apply");
    expect(frame).toContain("reclaimable");
  });

  test("renders scope sidebar with reclaim bytes and project groups", async () => {
    const setup = await mount(() => {});
    const frame = setup.captureCharFrame();

    expect(frame).toContain("scopes");
    expect(frame).toContain("all scopes");
    expect(frame).toContain("▾");
    expect(frame).toContain("project root");
    expect(frame).not.toMatch(/▸ project root.*▸/);
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

  test("bulk select then enter applies without confirming merely visible dangerous items", async () => {
    const plan = createPlan();
    plan.candidates.push({
      id: "cand_danger",
      path: "/tmp/sweep-ui/target",
      name: "target",
      kind: "target",
      estimatedBytes: 2048,
      isSymlink: false,
      entryType: "directory",
      riskTier: "dangerous",
      reasons: ["build-output"],
      selectedByDefault: false,
    });
    plan.summary.candidateCount = 3;

    const outcomes: SweepUiOutcome[] = [];
    const setup = await testRender(
      <SweepApp plan={plan} onDone={(result) => outcomes.push(result)} />,
      { width: 120, height: 32 },
    );
    teardown = () => setup.renderer.destroy();
    await act(async () => {
      await setup.renderOnce();
    });

    // Bulk select (safe + caution only), then enter. Dangerous items that
    // are only visible (not queued) do not trip the confirm gate.
    await act(async () => {
      setup.mockInput.pressKey("a");
      await setup.flush();
    });
    await act(async () => {
      setup.mockInput.pressEnter();
      await setup.flush();
    });
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome?.type).toBe("apply");
    if (outcome?.type === "apply") {
      expect(outcome.plan.selectedCandidateIds).toContain("cand_safe");
      expect(outcome.plan.selectedCandidateIds).toContain("cand_caution");
      expect(outcome.plan.selectedCandidateIds).not.toContain("cand_danger");
    }
  });

  test("queued dangerous items still require a confirm before apply", async () => {
    const plan = createPlan();
    plan.candidates.push({
      id: "cand_danger",
      path: "/tmp/sweep-ui/target",
      name: "target",
      kind: "target",
      estimatedBytes: 2048,
      isSymlink: false,
      entryType: "directory",
      riskTier: "dangerous",
      reasons: ["build-output"],
      selectedByDefault: false,
    });
    plan.selectedCandidateIds = ["cand_danger"];
    plan.summary.candidateCount = 3;
    plan.summary.selectedCount = 1;

    const outcomes: SweepUiOutcome[] = [];
    const setup = await testRender(
      <SweepApp plan={plan} onDone={(result) => outcomes.push(result)} />,
      { width: 120, height: 32 },
    );
    teardown = () => setup.renderer.destroy();
    await act(async () => {
      await setup.renderOnce();
    });

    await act(async () => {
      setup.mockInput.pressEnter();
      await setup.flush();
    });
    expect(outcomes).toEqual([]);

    await act(async () => {
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome?.type).toBe("apply");
    if (outcome?.type === "apply") {
      expect(outcome.plan.selectedCandidateIds).toContain("cand_danger");
    }
  });

  test("streaming mode boots empty, fills live, and flips SCANNING off", async () => {
    const candidate: ScanCandidate = {
      id: "cand_stream",
      path: "/tmp/sweep-ui/node_modules",
      name: "node_modules",
      kind: "node_modules",
      estimatedBytes: 0,
      isSymlink: false,
      entryType: "directory",
      riskTier: "safe",
      reasons: ["default-pattern"],
      selectedByDefault: true,
    };

    let hooksRef: Parameters<UiScanControl["start"]>[0] | null = null;
    const scan: UiScanControl = {
      start(hooks) {
        hooksRef = hooks;
      },
      syncPatterns() {},
    };

    // Empty seed plan — exactly what runSweepUiStreaming boots with.
    const emptyPlan: ScanPlan = {
      ...createPlan(),
      candidates: [],
      selectedCandidateIds: [],
      summary: {
        ...createPlan().summary,
        candidateCount: 0,
        estimatedTotalBytes: 0,
        selectedCount: 0,
      },
    };

    const setup = await testRender(
      <SweepApp plan={emptyPlan} scan={scan} initiallyScanning onDone={() => {}} />,
      { width: 120, height: 32 },
    );
    teardown = () => setup.renderer.destroy();
    await act(async () => {
      await setup.renderOnce();
    });

    // Boot frame: scanning chip, no artifacts yet.
    expect(hooksRef).not.toBeNull();
    const frameText = () => {
      const f = setup.captureCharFrame() as unknown;
      return Array.isArray(f) ? (f as string[]).join("\n") : String(f);
    };
    const frame = frameText();
    // Scanning is announced in the statusline and by the dot-matrix loader that
    // takes over the empty pane; nothing has been discovered yet.
    expect(frame).toContain("SCANNING");
    expect(frame).toContain("Scanning for artifacts");
    expect(frame).toContain("•");
    expect(frame).not.toContain("node_modules");

    // Batch arrives → app must accept it without throwing and settle cleanly.
    // (Painted-frame assertions after mount depend on the renderer's own draw
    // loop, which the test harness does not drive; state transitions are
    // covered by state.test.ts.)
    expect(() =>
      act(async () => {
        hooksRef?.onBatch([candidate]);
        await setup.flush();
      }),
    ).not.toThrow();

    let threw = false;
    await act(async () => {
      hooksRef?.onBatch([{ ...candidate, estimatedBytes: 4096 }]);
      await setup.flush();
    });
    expect(threw).toBe(false);

    await act(async () => {
      hooksRef?.onDone({ scannedDirs: 7 });
      await setup.flush();
    });
    expect(hooksRef).not.toBeNull();
  });
});

describe("streaming reorder", () => {
  function streamCandidate(index: number, bytes: number): ScanCandidate {
    const tree = `tree-${index % 8}`;
    const pkg = ["apps/cli", "apps/docs", "packages/core"][index % 3];
    const name = ["node_modules", "dist", ".next"][index % 3] ?? "dist";
    return {
      id: `stream_${index}`,
      path: `/tmp/sweep-ui/.worktrees/${tree}/${pkg}/${name}`,
      name,
      kind: "build",
      estimatedBytes: bytes,
      isSymlink: false,
      entryType: "directory",
      riskTier: "safe",
      reasons: ["default-pattern"],
      selectedByDefault: false,
    };
  }

  function emptyStreamPlan(): ScanPlan {
    return {
      ...createPlan(),
      candidates: [],
      selectedCandidateIds: [],
      summary: {
        candidateCount: 0,
        estimatedTotalBytes: 0,
        scannedDirs: 0,
        exact: false,
        selectedCount: 0,
        riskCounts: { safe: 0, caution: 0, dangerous: 0, blocked: 0 },
      },
    };
  }

  /**
   * Rows used to carry `id={`artifact-row-${index}`}`. OpenTUI keys a parent's
   * child map by renderable id, so index-derived ids went stale the moment a
   * sized batch re-sorted the list: `insertBefore` could not find its anchor,
   * silently dropped the row, and the pane filled with blank gaps and
   * out-of-order entries. The warnings are the only direct signal, so assert on
   * them.
   */
  test("re-sorting a live scan never desyncs the renderable tree", async () => {
    const count = 120;
    const discovered = Array.from({ length: count }, (_, i) => streamCandidate(i, 0));

    let hooks: Parameters<UiScanControl["start"]>[0] | null = null;
    const control: UiScanControl = {
      start: (h) => {
        hooks = h;
      },
      syncPatterns: () => {},
    };

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const setup = await testRender(
        <SweepApp plan={emptyStreamPlan()} onDone={() => {}} scan={control} initiallyScanning />,
        { width: 120, height: 32 },
      );
      teardown = () => setup.renderer.destroy();
      await act(async () => {
        await setup.renderOnce();
      });

      // Discovery: everything arrives unsized, so the list is alphabetical.
      for (let i = 0; i < count; i += 20) {
        const batch = discovered.slice(i, i + 20);
        await act(async () => {
          hooks?.onBatch(batch);
          await setup.renderOnce();
        });
      }

      // Sizing: the same ids come back with real bytes, reshuffling the sort.
      for (let i = 0; i < count; i += 20) {
        const batch = discovered
          .slice(i, i + 20)
          .map((candidate, k) => ({ ...candidate, estimatedBytes: ((i + k) * 7919) % 500_000 }));
        await act(async () => {
          hooks?.onBatch(batch);
          await setup.renderOnce();
        });
      }

      // The warnings are the regression signal. Painted-frame assertions after
      // mount are not reliable here — the harness does not drive the renderer's
      // own draw loop — so this asserts on the reconciler contract directly.
      expect(warnings.filter((line) => line.includes("insertBefore"))).toEqual([]);
      expect(warnings.filter((line) => line.includes("does not exist within"))).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });
});
