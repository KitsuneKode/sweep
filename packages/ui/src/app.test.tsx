import { afterEach, describe, expect, test } from "bun:test";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { testRender as nativeTestRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SweepApp, type SweepUiOutcome } from "./app.js";
import type { UiScanControl, UiScanHooks } from "./streaming.js";

// Match production signal ownership: renderer teardown must follow an app
// outcome, not a key or process signal handled by the cancellation bridge.
const testRender: typeof nativeTestRender = (node, options) =>
  nativeTestRender(node, {
    exitOnCtrlC: false,
    exitSignals: [],
    ...options,
  });

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

afterEach(async () => {
  await act(async () => {
    teardown?.();
    teardown = null;
  });
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
  test("inspect x confirms exactly the displayed candidate without applying the queue", async () => {
    const outcomes: SweepUiOutcome[] = [];
    const setup = await mount((outcome) => outcomes.push(outcome));
    const paint = async () => {
      for (let i = 0; i < 3; i++)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          await setup.renderOnce();
        });
    };
    await act(async () => {
      setup.mockInput.pressKey("i");
      await setup.renderOnce();
    });
    await paint();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("artifact");
    const pathRow = frame.split("\n").find((line) => /\bpath\s/.test(line));
    const displayed = createPlan().candidates.find((candidate) =>
      pathRow?.includes(candidate.name),
    );
    expect(displayed, frame).toBeDefined();
    await act(async () => {
      setup.mockInput.pressKey("x");
      await setup.renderOnce();
    });
    await paint();
    expect(setup.captureCharFrame()).toContain("Permanently delete");
    expect(outcomes).toEqual([]);
    await act(async () => {
      setup.mockInput.pressKey("y");
      await setup.renderOnce();
    });
    await paint();
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0]!;
    expect(outcome.type).toBe("apply");
    if (outcome.type === "apply")
      expect(outcome.plan.selectedCandidateIds).toEqual([displayed!.id]);
  });
  test("draws brand header, stats, and statusline chrome", async () => {
    const setup = await mount(() => {});
    const frame = setup.captureCharFrame();

    expect(frame.length).toBeGreaterThan(0);
    expect(frame).toContain("sweep");
    expect(frame).toContain("found");
    expect(frame).toContain("queued");
    expect(frame).toContain("apply");
    // The tally carries the queue's risk mix - the header owns the bytes.
    expect(frame).toContain("1 safe");
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

  test("enter while a scan is running warns instead of opening the confirm dialog", async () => {
    // A confirm whose candidate count is still growing under the user's eyes
    // is a trap - apply stays closed until the generation settles.
    const outcomes: SweepUiOutcome[] = [];
    // scanning only clears via onDone/onError, so a start() that resolves
    // without calling either keeps the generation open for the whole test.
    const pendingScan: UiScanControl = {
      start: () => Promise.resolve(),
      syncPatterns: () => {},
      setEngine: () => true,
    };
    const setup = await testRender(
      <SweepApp
        plan={createPlan()}
        scan={pendingScan}
        initiallyScanning
        onDone={(result) => outcomes.push(result)}
      />,
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
    await act(async () => {
      await setup.renderOnce();
    });

    const frame = setup.captureCharFrame();
    expect(frame).toContain("scan still running");
    expect(frame).not.toContain("Permanently delete");
    expect(outcomes).toEqual([]);
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

  test("failed scan remains incomplete after dismissal and a successful retry restores apply", async () => {
    const outcomes: SweepUiOutcome[] = [];
    let hooks: UiScanHooks | undefined;
    const control: UiScanControl = {
      start: (next) => {
        hooks = next;
        return Promise.resolve();
      },
      syncPatterns: () => {},
      setEngine: () => true,
    };
    const setup = await testRender(
      <SweepApp
        plan={createPlan()}
        scan={control}
        initiallyScanning
        onDone={(outcome) => outcomes.push(outcome)}
      />,
      { width: 120, height: 32 },
    );
    teardown = () => setup.renderer.destroy();
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          await setup.renderOnce();
        });
      }
    };
    await act(async () => {
      await setup.flush();
    });
    await act(async () => {
      hooks?.onError(new Error("scan transport failed"));
      await setup.flush();
    });
    await settle();
    expect(setup.captureCharFrame()).toContain("scan transport failed");
    await act(async () => {
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await setup.flush();
    });
    await act(async () => {
      setup.mockInput.pressEnter();
      await setup.flush();
    });
    await settle();
    expect(setup.captureCharFrame()).toContain("scan incomplete");
    await settle();
    expect(setup.captureCharFrame()).toContain("INCOMPLETE");
    expect(outcomes).toEqual([]);
    await act(async () => {
      setup.mockInput.pressKey("S");
      await setup.flush();
    });
    await settle();
    expect(setup.captureCharFrame()).toContain("before saving");
    await act(async () => {
      setup.mockInput.pressKey("r");
      await setup.flush();
    });
    await act(async () => {
      hooks?.onBatch(createPlan().candidates);
      hooks?.onDone({ scannedDirs: 3, skippedDirs: 0, plan: createPlan() });
      await setup.flush();
    });
    await act(async () => {
      setup.mockInput.pressEnter();
      await setup.flush();
    });
    await settle();
    expect(setup.captureCharFrame()).toContain("Permanently delete");
    expect(outcomes).toEqual([]);
  });

  test("scan progress distinguishes pending sizes and refuses a premature plan export", async () => {
    let hooks: UiScanHooks | undefined;
    const setup = await testRender(
      <SweepApp
        plan={createPlan()}
        initiallyScanning
        scan={{
          start: (next) => {
            hooks = next;
            return Promise.resolve();
          },
          syncPatterns: () => {},
          setEngine: () => true,
        }}
        onDone={() => {}}
      />,
      { width: 120, height: 32 },
    );
    teardown = () => setup.renderer.destroy();
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          await setup.renderOnce();
        });
      }
    };
    await act(async () => {
      await setup.flush();
    });
    await act(async () => {
      hooks?.onBatch(createPlan().candidates);
      hooks?.onProgress?.({ scannedDirs: 4, skippedDirs: 0, sizedCount: 1 });
      await setup.flush();
    });
    await settle();
    expect(setup.captureCharFrame()).toContain("1 sizing");
    // The sidebar meter reports sizing progress while the scan runs -
    // queue coverage would sit near 100% under default selection and read
    // as "done" on a scan that can still fail.
    const midScan = setup.captureCharFrame();
    expect(midScan).toContain("1 sized");
    expect(midScan).toContain("of");
    expect(midScan).toContain("2 found");
    expect(midScan).not.toContain("100%");
    await act(async () => {
      setup.mockInput.pressKey("S");
      await setup.flush();
    });
    await settle();
    expect(setup.captureCharFrame()).toContain("before saving");
    await act(async () => {
      hooks?.onProgress?.({ scannedDirs: 5, skippedDirs: 0, sizedCount: 2 });
      await setup.flush();
    });
    await settle();
    expect(setup.captureCharFrame()).not.toContain("1 sizing");
    // Even at sized == found the scanning meter clamps under 100% - only a
    // completed scan earns a full bar.
    expect(setup.captureCharFrame()).not.toContain("100%");
    await act(async () => {
      hooks?.onDone({ scannedDirs: 5, skippedDirs: 0, plan: createPlan() });
      await setup.flush();
    });
    await settle();
    expect(setup.captureCharFrame()).toContain("found");
  });

  test("select-all then enter still asks for confirmation before applying", async () => {
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
    // Safe/caution-only queues are deletions too - enter opens the dialog,
    // nothing is applied until y.
    expect(outcomes).toEqual([]);

    await act(async () => {
      setup.mockInput.pressKey("y");
      await setup.flush();
    });

    const outcome = outcomes[0];
    expect(outcome?.type).toBe("apply");
    if (outcome?.type === "apply") {
      expect(outcome.plan.selectedCandidateIds).toContain("cand_safe");
      expect(outcome.plan.selectedCandidateIds).toContain("cand_caution");
    }
  });

  test("bulk select then enter confirms, and merely visible dangerous items are excluded", async () => {
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

    // Bulk select (safe + caution only), then enter - the confirm dialog
    // still opens (every apply is destructive), and dangerous items that are
    // only visible are never queued by `a`.
    await act(async () => {
      setup.mockInput.pressKey("a");
      await setup.flush();
    });
    await act(async () => {
      setup.mockInput.pressEnter();
      await setup.flush();
    });
    expect(outcomes).toHaveLength(0);
    await act(async () => {
      setup.mockInput.pressKey("y");
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
      async start(hooks) {
        hooksRef = hooks;
      },
      syncPatterns() {},
      setEngine: () => true,
    };

    // Empty seed plan - exactly what runSweepUiStreaming boots with.
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
    // covered by state.test.ts.) This act must be awaited - a dangling async
    // act leaves the shared act queue scoped open, which swallows renders
    // from whichever test file runs next on the runner's scheduling.
    await act(async () => {
      hooksRef?.onBatch([candidate]);
      await setup.flush();
    });

    // Any rejected act or renderer exception fails this test directly.
    await act(async () => {
      hooksRef?.onBatch([{ ...candidate, estimatedBytes: 4096 }]);
      await setup.flush();
    });

    await act(async () => {
      hooksRef?.onDone({ scannedDirs: 7, skippedDirs: 0 });
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
      start: async (h) => {
        hooks = h;
      },
      syncPatterns: () => {},
      setEngine: () => true,
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
      // mount are not reliable here - the harness does not drive the renderer's
      // own draw loop - so this asserts on the reconciler contract directly.
      expect(warnings.filter((line) => line.includes("insertBefore"))).toEqual([]);
      expect(warnings.filter((line) => line.includes("does not exist within"))).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });
});

test("a synchronous scan startup failure renders an incomplete error instead of escaping", async () => {
  const scan: UiScanControl = {
    start: () => {
      throw new Error("startup failed");
    },
    syncPatterns: () => {},
    setEngine: () => true,
  };
  const setup = await testRender(
    <SweepApp plan={createPlan()} onDone={() => {}} scan={scan} initiallyScanning />,
    { width: 120, height: 32 },
  );
  teardown = () => setup.renderer.destroy();
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await setup.renderOnce();
    });
  }
  expect(setup.captureCharFrame()).toContain("startup failed");
  expect(setup.captureCharFrame()).toContain("scan error");
});
