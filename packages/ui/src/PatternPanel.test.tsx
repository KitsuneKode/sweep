import { afterEach, expect, test } from "bun:test";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { PatternPanel } from "./PatternPanel.js";
import { createUiState, type SweepUiState } from "./state.js";
import { darkTheme } from "./theme.js";

let destroy: (() => void) | undefined;
afterEach(async () => {
  await act(async () => destroy?.());
  destroy = undefined;
});
const plan: ScanPlan = {
  protocolVersion: "1",
  targetDir: "/tmp/pattern-pointer",
  createdAt: new Date().toISOString(),
  selectionPolicy: { mode: "none", includeDangerous: false },
  candidates: [],
  selectedCandidateIds: [],
  summary: {
    candidateCount: 0,
    selectedCount: 0,
    estimatedTotalBytes: 0,
    scannedDirs: 0,
    exact: false,
    riskCounts: { safe: 0, caution: 0, dangerous: 0, blocked: 0 },
  },
};

test("pattern names only focus; checkboxes require left release; save is available by mouse", async () => {
  let latest!: SweepUiState;
  let saves = 0;
  function Harness() {
    const [state, setState] = useState<SweepUiState>(() => ({
      ...createUiState(plan, { catalogPatterns: ["node_modules", "target"] }),
      focus: "patterns" as const,
    }));
    latest = state;
    return (
      <PatternPanel
        state={state}
        tokens={darkTheme}
        paneWidth={50}
        onMutate={(fn) => setState((s) => fn(s))}
        onSubmitDraft={() => {}}
        onSave={() => saves++}
      />
    );
  }
  const setup = await testRender(<Harness />, { width: 50, height: 16 });
  destroy = () => setup.renderer.destroy();
  const send = async (fn: () => Promise<void>) => {
    await act(async () => {
      await fn();
      await setup.flush();
    });
    await act(async () => {
      await setup.renderOnce();
    });
  };
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  let lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes("node_modules"));
  expect(y).toBeGreaterThanOrEqual(0);
  const x = lines[y]!.indexOf("node_modules") + 1;
  await send(() => setup.mockMouse.click(x, y, 2));
  await send(() => setup.mockMouse.click(x, y));
  await send(() => setup.mockMouse.click(x, y));
  expect(latest.disabledPatterns.has("node_modules")).toBe(false);
  lines = setup.captureCharFrame().split("\n");
  const box = lines[y]!.indexOf("[x]") + 1;
  expect(box).toBeGreaterThan(0);
  await send(() => setup.mockMouse.pressDown(box, y));
  expect(latest.disabledPatterns.has("node_modules")).toBe(false);
  await send(() => setup.mockMouse.release(box, y));
  expect(latest.disabledPatterns.has("node_modules")).toBe(true);
  await send(() => setup.mockMouse.drag(box, y, box + 1, y));
  await send(() => setup.mockMouse.click(box, y, 1));
  expect(latest.disabledPatterns.has("node_modules")).toBe(true);
  lines = setup.captureCharFrame().split("\n");
  const saveY = lines.findIndex((line) => line.includes("Save"));
  expect(saveY).toBeGreaterThanOrEqual(0);
  await send(() => setup.mockMouse.click(lines[saveY]!.indexOf("Save") + 1, saveY));
  expect(saves).toBe(1);
});

for (const width of [24, 50]) {
  test(`pattern controls remain usable at ${width} cells without losing drafts or full names`, async () => {
    const pattern = "生成物🧹".repeat(12);
    let latest!: SweepUiState;
    let inspected: string | undefined;
    let saves = 0;
    let submits = 0;
    function Harness() {
      const [state, setState] = useState<SweepUiState>(() => ({
        ...createUiState(plan, { catalogPatterns: [], extraPatterns: [pattern] }),
        focus: "patterns",
      }));
      latest = state;
      return (
        <PatternPanel
          state={state}
          tokens={darkTheme}
          paneWidth={width}
          onMutate={(fn) => setState(fn)}
          onSubmitDraft={() => submits++}
          onSave={() => saves++}
          onInspect={(value) => {
            inspected = value;
          }}
        />
      );
    }
    const setup = await testRender(<Harness />, { width, height: 16 });
    destroy = () => setup.renderer.destroy();
    const paint = async () =>
      act(async () => {
        await setup.flush();
        await setup.renderOnce();
      });
    const click = async (label: string) => {
      const lines = setup.captureCharFrame().split("\n");
      // Buttons are filled pills: the label sits between one cell of padding.
      const y = lines.findIndex((line) => line.includes(` ${label} `));
      expect(y).toBeGreaterThanOrEqual(0);
      await act(async () => {
        await setup.mockMouse.click(lines[y]!.indexOf(` ${label} `) + 1, y);
        await setup.flush();
      });
      await paint();
    };
    await paint();
    expect(setup.captureCharFrame()).toContain("生成物");
    await click("Details");
    expect(inspected).toBe(pattern);
    await click("Add");
    await act(async () => {
      setup.mockInput.pressKey("draft");
      await setup.flush();
    });
    await paint();
    expect(latest.patternDraft).toBe("draft");
    await click("Add");
    expect(latest.patternDraft).toBe("draft");
    await click("Save");
    expect(saves).toBe(0);
    await click("Add pattern");
    expect(submits).toBe(1);
  });
}
