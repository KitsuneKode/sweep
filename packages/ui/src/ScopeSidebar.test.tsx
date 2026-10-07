import { afterEach, expect, test } from "bun:test";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import type { BaseRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { ScopeSidebar } from "./ScopeSidebar.js";
import { createUiState, moveSidebarCursor, type SweepUiState } from "./state.js";
import { darkTheme } from "./theme.js";

let teardown: (() => void) | undefined;
afterEach(async () => {
  await act(async () => teardown?.());
  teardown = undefined;
});

function plan(count: number): ScanPlan {
  const candidates = Array.from({ length: count }, (_, i) => ({
    id: `cand_${i}`,
    path: `/tmp/sweep-sidebar/pkg${String(i).padStart(5, "0")}/node_modules`,
    name: "node_modules",
    kind: "node_modules" as const,
    estimatedBytes: 1024,
    entryType: "directory" as const,
    isSymlink: false,
    riskTier: "safe" as const,
    reasons: ["default-pattern"],
    selectedByDefault: true,
  }));
  return {
    protocolVersion: "1",
    targetDir: "/tmp/sweep-sidebar",
    candidates,
    selectedCandidateIds: [],
    selectionPolicy: { mode: "default", includeDangerous: false },
    summary: {
      candidateCount: count,
      estimatedTotalBytes: count * 1024,
      scannedDirs: count + 1,
      exact: true,
      selectedCount: 0,
      riskCounts: { safe: count, caution: 0, dangerous: 0, blocked: 0 },
    },
    createdAt: new Date().toISOString(),
  };
}

function descendantCount(root: BaseRenderable): number {
  let count = 0;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    count++;
    for (const child of node.getChildren()) pending.push(child);
  }
  return count;
}

test("10,000 folders mount only a viewport and preserve the cursor through seeking and resize", async () => {
  let selected: string | null | undefined;
  let cursor = 0;
  function Harness() {
    const [state, setState] = useState<SweepUiState>(() => ({
      ...createUiState(plan(10_000)),
      focus: "sidebar" as const,
    }));
    cursor = state.sidebarIndex;
    useKeyboard((key) => {
      if (key.name === "g" && key.shift) setState((s) => moveSidebarCursor(s, 100_000));
      if (key.name === "g" && !key.shift) setState((s) => moveSidebarCursor(s, -100_000));
    });
    return (
      <ScopeSidebar
        state={state}
        tokens={darkTheme}
        focused
        paneWidth={36}
        onApplyScope={(scope) => {
          selected = scope;
        }}
        onCursorDelta={(delta) => setState((s) => moveSidebarCursor(s, delta))}
        onSetCursor={(index) => setState((s) => moveSidebarCursor(s, index - s.sidebarIndex))}
      />
    );
  }
  const setup = await testRender(<Harness />, { width: 40, height: 20 });
  teardown = () => setup.renderer.destroy();
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  expect(setup.captureCharFrame()).toContain("all scopes");
  expect(descendantCount(setup.renderer.root)).toBeLessThan(200);
  await act(async () => {
    setup.mockInput.pressKey("G");
    await setup.flush();
  });
  await act(async () => {
    await setup.renderOnce();
  });
  expect(cursor).toBe(10_000);
  expect(setup.captureCharFrame()).toContain("pkg09999/");
  expect(descendantCount(setup.renderer.root)).toBeLessThan(200);
  await act(async () => {
    setup.resize(40, 10);
    await setup.flush();
    await setup.renderOnce();
  });
  await act(async () => {
    await setup.waitForFrame((frame) => frame.includes("pkg09999/"));
  });
  expect(setup.captureCharFrame()).toContain("pkg09999/");
  expect(descendantCount(setup.renderer.root)).toBeLessThan(120);
  await act(async () => {
    setup.mockInput.pressKey("g");
    await setup.flush();
  });
  await act(async () => {
    await setup.renderOnce();
  });
  expect(cursor).toBe(0);
  expect(setup.captureCharFrame()).toContain("all scopes");
  await act(async () => {
    await setup.mockMouse.scroll(3, 3, "down");
    await setup.flush();
  });
  await act(async () => {
    await setup.renderOnce();
  });
  expect(cursor).toBe(3);
  const lines = setup.captureCharFrame().split("\n");
  const x = Math.max(...lines.map((line) => line.lastIndexOf("░")));
  const top = lines.findIndex((line) => /[░█]/.test(line[x] ?? ""));
  const bottom = lines.reduce(
    (last, line, index) => (/[░█]/.test(line[x] ?? "") ? index : last),
    -1,
  );
  await act(async () => {
    await setup.mockMouse.click(x, bottom - 1);
    await setup.flush();
  });
  await act(async () => {
    await setup.renderOnce();
  });
  expect(cursor).toBeGreaterThan(5_000);
  await act(async () => {
    await setup.mockMouse.click(x, top);
    await setup.flush();
  });
  await act(async () => {
    await setup.renderOnce();
  });
  expect(cursor).toBe(0);
  const scopeY = setup
    .captureCharFrame()
    .split("\n")
    .findIndex((line) => line.includes("pkg00000/"));
  await act(async () => {
    await setup.mockMouse.click(5, scopeY);
    await setup.flush();
  });
  expect(selected).toBe("pkg00000");
});

test("invalidated review does not claim that every size is a lower bound", async () => {
  const state = { ...createUiState(plan(1)), scanIncomplete: true };
  const setup = await testRender(
    <ScopeSidebar
      state={state}
      tokens={darkTheme}
      focused={false}
      paneWidth={40}
      onApplyScope={() => {}}
    />,
    { width: 44, height: 12 },
  );
  teardown = () => setup.renderer.destroy();
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const frame = setup.captureCharFrame();
  expect(frame).toContain("review incomplete");
  expect(frame).toContain("rescan before applying");
  expect(frame).not.toContain("lower bounds");
});
