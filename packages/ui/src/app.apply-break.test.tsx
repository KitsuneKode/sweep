/**
 * ADVERSARIAL REPRO — scratch diagnostic tests for the in-session apply
 * lifecycle. Each test encodes what the UI *should* do; a RED result is a
 * confirmed break. Same-drain bursts are two pressKey calls inside one act()
 * with no render/flush between — both keys dispatch against the same
 * committed React snapshot, exactly like coalesced stdin bytes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import { testRender as nativeTestRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SweepApp, type SweepUiOutcome } from "./app.js";
import type { UiApplyRequest, UiApplyResult } from "./outcome.js";
import type { UiScanControl } from "./streaming.js";
import { requestUiApplyCancellation } from "./runtime.js";
import { BoxRenderable } from "@opentui/core";

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

interface ApplyCall extends Omit<UiApplyRequest, "engine"> {
  resolved?: boolean;
}

/**
 * Mounts the app with a controllable in-session apply channel. `applyCalls`
 * records every request; each call returns a promise the test resolves or
 * rejects when it wants the apply to finish.
 */
async function mountWithApply(
  onDone: (outcome: SweepUiOutcome) => void,
  applyPolicy?: UiScanControl["applyPolicy"],
  fixturePlan: ScanPlan = createPlan(),
) {
  const applyCalls: ApplyCall[] = [];
  const applyResolvers: ((result: UiApplyResult) => void)[] = [];
  const applyRejecters: ((error: unknown) => void)[] = [];
  let scanStarts = 0;
  let hooksRef: Parameters<UiScanControl["start"]>[0] | undefined;
  const control: UiScanControl = {
    ...(applyPolicy ? { applyPolicy } : {}),
    start: (hooks) => {
      scanStarts += 1;
      hooksRef = hooks;
      return Promise.resolve();
    },
    syncPatterns: () => {},
    setEngine: () => true,
    apply: (request) => {
      applyCalls.push(request);
      return new Promise<UiApplyResult>((resolve, reject) => {
        applyResolvers.push(resolve);
        applyRejecters.push(reject);
      });
    },
  };
  const setup = await testRender(<SweepApp plan={fixturePlan} scan={control} onDone={onDone} />, {
    width: 120,
    height: 32,
    exitOnCtrlC: false,
  });
  teardown = () => setup.renderer.destroy();
  await act(async () => {
    await setup.renderOnce();
  });
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await setup.renderOnce();
      });
    }
  };
  /** Open the single-row confirm for whatever row the cursor sits on, armed. */
  const openSingleConfirm = async () => {
    await act(async () => {
      setup.mockInput.pressKey("x");
      await setup.flush();
    });
    await settle();
    // confirmArmedAtRef flips to -Inf after the first committed paint; the
    // 150ms sleep covers the 100ms wall-clock fallback either way.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle();
  };
  return {
    setup,
    settle,
    openSingleConfirm,
    applyCalls,
    applyResolvers,
    applyRejecters,
    scanControl: {
      get starts() {
        return scanStarts;
      },
      get hooks() {
        return hooksRef;
      },
    },
  };
}

describe("adversarial: same-drain bursts on the confirm dialog", () => {
  test("n then y in one drain must NOT apply the dismissed single row", async () => {
    const outcomes: SweepUiOutcome[] = [];
    const { setup, settle, openSingleConfirm, applyCalls } = await mountWithApply((o) =>
      outcomes.push(o),
    );
    await openSingleConfirm();
    expect(setup.captureCharFrame()).toContain("delete");

    await act(async () => {
      setup.mockInput.pressKey("n");
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    await settle();

    // The user dismissed. Nothing may apply, in-session or via exit-apply.
    expect(applyCalls.length).toBe(0);
    expect(outcomes).toEqual([]);
  });

  test("y then y in one drain starts exactly ONE apply", async () => {
    const { setup, settle, openSingleConfirm, applyCalls } = await mountWithApply(() => {});
    await openSingleConfirm();

    await act(async () => {
      setup.mockInput.pressKey("y");
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    await settle();

    expect(applyCalls.length).toBe(1);
  });

  test("t then y in one drain must apply with the NEW trash mode, not the old", async () => {
    const { setup, settle, openSingleConfirm, applyCalls } = await mountWithApply(() => {});
    await openSingleConfirm();

    // t flips the dialog's mode chip to "move to trash"; y must honour it.
    await act(async () => {
      setup.mockInput.pressKey("t");
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    await settle();

    expect(applyCalls.length).toBe(1);
    expect(applyCalls[0]!.trash).toBe(true);
  });

  test("y then ctrl+C in one drain aborts the in-flight apply, it does not exit-abort", async () => {
    const outcomes: SweepUiOutcome[] = [];
    const { setup, settle, openSingleConfirm, applyCalls } = await mountWithApply((o) =>
      outcomes.push(o),
    );
    await openSingleConfirm();

    await act(async () => {
      setup.mockInput.pressKey("y");
      setup.mockInput.pressCtrlC();
      await setup.flush();
    });
    await settle();

    // Correct behaviour: the apply's AbortSignal fires (abortApply), the
    // session stays, no abort outcome is emitted.
    expect(applyCalls.length).toBe(1);
    expect(applyCalls[0]!.signal.aborted).toBe(true);
    expect(outcomes).toEqual([]);
  });

  test("y then r in one drain must not start a rescan while an apply is in flight", async () => {
    const { setup, settle, openSingleConfirm, applyCalls, scanControl } = await mountWithApply(
      () => {},
    );
    await openSingleConfirm();

    await act(async () => {
      setup.mockInput.pressKey("y");
      setup.mockInput.pressKey("r");
      await setup.flush();
    });
    await settle();

    expect(applyCalls.length).toBe(1);
    // A rescan while the engine is deleting the listed tree is undefined
    // territory - the apply gate must have won.
    expect(scanControl.starts).toBe(0);
  });

  test("y then i in one drain must not open inspect over an in-flight apply", async () => {
    const { setup, settle, openSingleConfirm, applyCalls } = await mountWithApply(() => {});
    await openSingleConfirm();

    await act(async () => {
      setup.mockInput.pressKey("y");
      setup.mockInput.pressKey("i");
      await setup.flush();
    });
    await settle();

    expect(applyCalls.length).toBe(1);
    // Inspect is a modal the keymap cannot dismiss while applying (esc hits
    // the applying early-return before the inspect branch) - if it opened,
    // the user is trapped behind it until the apply lands.
    expect(setup.captureCharFrame()).not.toContain("artifact detail");
  });
});

describe("adversarial: same-drain bursts on the queue confirm", () => {
  test("n then y in one drain must NOT apply the dismissed queue", async () => {
    const outcomes: SweepUiOutcome[] = [];
    const { setup, settle } = await mountWithApply((o) => outcomes.push(o));
    await act(async () => {
      setup.mockInput.pressEnter();
      await setup.flush();
    });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle();
    expect(setup.captureCharFrame()).toContain("delete");

    await act(async () => {
      setup.mockInput.pressKey("n");
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    await settle();

    expect(outcomes).toEqual([]);
  });

  test("queue apply stays in session and Ctrl+C stops it in the same drain", async () => {
    const outcomes: SweepUiOutcome[] = [];
    const { setup, settle, applyCalls } = await mountWithApply((o) => outcomes.push(o));
    await act(async () => {
      setup.mockInput.pressEnter();
      await setup.flush();
    });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle();

    await act(async () => {
      setup.mockInput.pressKey("y");
      setup.mockInput.pressCtrlC();
      await setup.flush();
    });
    await settle();

    expect(outcomes).toEqual([]);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.signal.aborted).toBe(true);
    expect(setup.captureCharFrame()).toContain("Stopping");
  });
});

describe("adversarial: committed applying state", () => {
  test("single-item confirmation stays compact instead of filling the terminal", async () => {
    const { setup, openSingleConfirm } = await mountWithApply(() => {});
    await openSingleConfirm();
    const pending = [...setup.renderer.root.getChildren()];
    let height = 0;
    while (pending.length) {
      const node = pending.pop()!;
      if (node instanceof BoxRenderable && node.title?.trim() === "apply") height = node.height;
      pending.push(...node.getChildren());
    }
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThanOrEqual(18);
  });

  test("long-path review keeps confirmation controls visible and permits keyboard scrolling", async () => {
    const fixture = createPlan();
    fixture.candidates[0]!.path = `/tmp/sweep-ui/${"long-component/".repeat(70)}tail-marker/node_modules`;
    fixture.candidates = [fixture.candidates[0]!];
    const { setup, settle, openSingleConfirm } = await mountWithApply(() => {}, undefined, fixture);
    await openSingleConfirm();
    expect(setup.captureCharFrame()).toContain("y confirm    n / esc cancel");
    await act(async () => {
      for (let i = 0; i < 5; i++) setup.mockInput.pressKey("\x1b[6~");
      await setup.flush();
    });
    await settle();
    expect(setup.captureCharFrame()).toContain("tail-marker");
    expect(setup.captureCharFrame()).toContain("y confirm    n / esc cancel");
  });
  test("once applying commits, every mutating key is ignored until the apply lands", async () => {
    const outcomes: SweepUiOutcome[] = [];
    const { setup, settle, openSingleConfirm, applyCalls } = await mountWithApply((o) =>
      outcomes.push(o),
    );
    await openSingleConfirm();

    await act(async () => {
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    await settle();
    expect(applyCalls.length).toBe(1);

    for (const key of ["down", "x", "enter", "a", "t", "i", "r", "q"]) {
      await act(async () => {
        if (key === "down") setup.mockInput.pressArrow("down");
        else if (key === "enter") setup.mockInput.pressEnter();
        else setup.mockInput.pressKey(key);
        await setup.flush();
      });
    }
    await settle();

    expect(applyCalls.length).toBe(1);
    expect(outcomes).toEqual([]);
    expect(setup.captureCharFrame()).toContain("applying");
    expect(setup.captureCharFrame()).not.toContain("artifact detail");
  });

  test("in-flight apply shows elapsed time and backend completion counts", async () => {
    const { setup, settle, openSingleConfirm, applyCalls } = await mountWithApply(() => {});
    await openSingleConfirm();
    await act(async () => {
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    await settle();
    expect(setup.captureCharFrame()).toContain("0 / 1 removals completed");
    expect(setup.captureCharFrame()).toContain("counting targets");
    await act(async () => {
      applyCalls[0]!.onProgress?.({
        stage: "applying",
        selectedCount: 1,
        deletedCount: 0,
        estimatedBytesFreed: 0,
        elapsedMs: 2000,
        removedEntries: 1234,
        activePath: "/tmp/sweep-ui/node_modules",
      });
      await setup.flush();
    });
    await settle();
    expect(setup.captureCharFrame()).toContain("1,234 entries removed inside this item");
    expect(setup.captureCharFrame()).toContain("0% of items");
    await act(async () => {
      applyCalls[0]!.onProgress?.({
        stage: "applying",
        selectedCount: 1,
        deletedCount: 1,
        estimatedBytesFreed: 1024,
        elapsedMs: 4300,
        activePath: "/tmp/sweep-ui/node_modules",
      });
      await setup.renderOnce();
    });
    await settle();
    expect(setup.captureCharFrame()).toContain("1 / 1 removals completed");
    expect(setup.captureCharFrame()).toContain("4.3s");
    expect(setup.captureCharFrame()).toContain("99% of items");
    expect(setup.captureCharFrame()).toContain("report pending");
  });

  test("preparation has its own percentage and stopping stays responsive", async () => {
    const { setup, settle, openSingleConfirm, applyCalls } = await mountWithApply(() => {});
    await openSingleConfirm();
    await act(async () => {
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    await settle();
    await act(async () => {
      applyCalls[0]!.onProgress?.({
        stage: "preparing",
        selectedCount: 1,
        deletedCount: 0,
        estimatedBytesFreed: 0,
        elapsedMs: 2500,
        preparationPhase: "sizing",
        preparedCount: 1,
        preparingCount: 2,
      });
    });
    await settle();
    expect(setup.captureCharFrame()).toContain("Size check · 50%");
    await act(async () => {
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 35));
      await setup.flush();
    });
    await settle();
    expect(applyCalls[0]!.signal.aborted).toBe(true);
    expect(setup.captureCharFrame()).toContain("Stopping");
  });

  test("terminal signals request cancellation without closing an active apply", async () => {
    const outcomes: SweepUiOutcome[] = [];
    const { setup, settle, openSingleConfirm, applyCalls } = await mountWithApply((o) =>
      outcomes.push(o),
    );
    expect(requestUiApplyCancellation()).toBe(false);
    await openSingleConfirm();
    await act(async () => {
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    await settle();
    await act(async () => {
      expect(requestUiApplyCancellation()).toBe(true);
    });
    await settle();
    expect(applyCalls[0]!.signal.aborted).toBe(true);
    expect(outcomes).toEqual([]);
    expect(setup.captureCharFrame()).toContain("Stopping");
  });

  test("clicking stop requests cancellation without dismissing the apply", async () => {
    const outcomes: SweepUiOutcome[] = [];
    const { setup, settle, openSingleConfirm, applyCalls } = await mountWithApply((o) =>
      outcomes.push(o),
    );
    await openSingleConfirm();
    await act(async () => {
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    await settle();
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("click here to stop"));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = lines[y]!.indexOf("esc / ctrl-c");
    await act(async () => {
      await setup.mockMouse.click(x, y);
      await setup.flush();
    });
    await settle();
    expect(applyCalls[0]!.signal.aborted).toBe(true);
    expect(outcomes).toEqual([]);
    expect(setup.captureCharFrame()).toContain("Stopping");
  });

  test("missing final report blocks destructive retries until a rescan", async () => {
    const { setup, settle, openSingleConfirm, applyRejecters, applyCalls } = await mountWithApply(
      () => {},
    );
    await openSingleConfirm();
    await act(async () => {
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    await settle();
    await act(async () => {
      applyRejecters[0]!(new Error("engine pipe closed"));
    });
    await settle();
    expect(setup.captureCharFrame()).toContain("INCOMPLETE");
    await act(async () => {
      setup.mockInput.pressKey("x");
      setup.mockInput.pressEnter();
      await setup.flush();
    });
    await settle();
    expect(applyCalls).toHaveLength(1);
    expect(setup.captureCharFrame()).not.toContain("confirm");
  });

  test("ctrl+C while applying aborts the signal and keeps the session alive", async () => {
    const outcomes: SweepUiOutcome[] = [];
    const { setup, settle, openSingleConfirm, applyCalls } = await mountWithApply((o) =>
      outcomes.push(o),
    );
    await openSingleConfirm();

    await act(async () => {
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    await settle();
    await act(async () => {
      setup.mockInput.pressCtrlC();
      await setup.flush();
    });
    await settle();

    expect(applyCalls[0]!.signal.aborted).toBe(true);
    expect(outcomes).toEqual([]);
  });
});

describe("adversarial: apply resolution state surgery", () => {
  test("resolved apply removes the row, clears the modal, restores input", async () => {
    const { setup, settle, openSingleConfirm, applyCalls, applyResolvers } = await mountWithApply(
      () => {},
    );
    await openSingleConfirm();
    expect(setup.captureCharFrame()).toContain("Only this item");
    expect(setup.captureCharFrame()).toContain("1 other queued item stays queued");
    await act(async () => {
      setup.mockInput.pressEnter();
      await setup.flush();
    });
    await settle();
    expect(applyCalls).toHaveLength(0);
    expect(setup.captureCharFrame()).toContain("Press y to confirm");
    await act(async () => {
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    await settle();

    const appliedId = applyCalls[0]!.plan.selectedCandidateIds[0]!;
    await act(async () => {
      applyResolvers[0]!({
        report: {
          protocolVersion: "1",
          targetDir: "/tmp/sweep-ui",
          selectedCandidateIds: [appliedId],
          deletedCount: 1,
          failedCount: 0,
          totalBytesFreed: 1024,
          failedPaths: [],
          outcomes: [{ candidateId: appliedId, status: "deleted" }],
        },
        interrupted: false,
      });
      await setup.flush();
    });
    await settle();

    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("Removing");
    // The applied row is gone from the list (its name survives only inside
    // the "deleted X" notice); the summary recomputed to one candidate.
    expect(frame).toContain("1 found");
    expect(frame).toContain("1 deleted");
    expect(frame).toContain("1 still queued");
    // Input works again: a second single apply can be requested.
    await act(async () => {
      setup.mockInput.pressKey("x");
      await setup.flush();
    });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle();
    await act(async () => {
      setup.mockInput.pressKey("y");
      await setup.flush();
    });
    await settle();
    expect(applyCalls.length).toBe(2);
  });
});

test("known pre-delete refusal preserves the complete scan and queued selection", async () => {
  const { setup, settle, openSingleConfirm, applyRejecters, applyCalls } = await mountWithApply(
    () => {},
  );
  await openSingleConfirm();
  await act(async () => {
    setup.mockInput.pressKey("y");
    await setup.flush();
  });
  await settle();
  await act(async () => {
    applyRejecters[0]!(
      Object.assign(new Error("Selection exceeds 10 GiB limit; use --force-large --yes."), {
        applyOutcome: "not_started",
        refusalCode: "size_limit_exceeded",
      }),
    );
    await setup.flush();
  });
  await settle();
  const frame = setup.captureCharFrame();
  expect(frame).not.toContain("INCOMPLETE");
  expect(frame).toContain("1 queued");
  expect(frame).toContain("Nothing removed");
  await openSingleConfirm();
  await act(async () => {
    setup.mockInput.pressKey("y");
    await setup.flush();
  });
  await settle();
  expect(applyCalls).toHaveLength(2);
});

test("confirmation exposes the ceiling and explicit override instructions", async () => {
  const { setup, openSingleConfirm } = await mountWithApply(() => {}, {
    maxSizeGB: 0,
    forceLarge: false,
  });
  await openSingleConfirm();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Size ceiling: 0 GiB");
  expect(frame).toContain("--force-large --yes");
  expect(frame).toContain("Over the limit");
});

test("uncapped confirmation remains explicit without inventing an over-limit refusal", async () => {
  const { setup, openSingleConfirm } = await mountWithApply(() => {}, {
    maxSizeGB: null,
    forceLarge: false,
  });
  await openSingleConfirm();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("No byte ceiling");
  expect(frame).not.toContain("Over the limit");
  expect(frame).toContain("Permanently delete");
});
