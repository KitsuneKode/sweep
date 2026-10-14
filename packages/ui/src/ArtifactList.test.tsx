import { expect, test } from "bun:test";
import { BoxRenderable, RGBA, type BaseRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { ArtifactList } from "./ArtifactList.js";
import type { UiDisplayRow } from "./rows.js";
import { darkTheme } from "./theme.js";

test("item names only focus; queue checkboxes require a left release without dragging", async () => {
  const item: ScanCandidate = {
    id: "one",
    name: "node_modules",
    path: "/owned/node_modules",
    kind: "node_modules",
    estimatedBytes: 512,
    entryType: "directory",
    isSymlink: false,
    riskTier: "safe",
    reasons: [],
    selectedByDefault: false,
  };
  let toggles = 0;
  let focused = 0;
  const setup = await testRender(
    <ArtifactList
      rows={[{ kind: "item", candidateId: item.id, groupLabel: "" }]}
      candidatesById={new Map([[item.id, item]])}
      selectedIds={new Set()}
      currentRowIndex={0}
      focused
      tokens={darkTheme}
      paneWidth={40}
      onSetCursor={() => focused++}
      onToggleSelection={() => toggles++}
    />,
    { width: 40, height: 10 },
  );
  try {
    await act(async () => {
      await setup.renderOnce();
      await setup.flush();
    });
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("node_modules"));
    const x = lines[y]!.indexOf("[ ]") + 1;
    const send = async (fn: () => Promise<void>) =>
      act(async () => {
        await fn();
        await setup.flush();
      });
    await send(() => setup.mockMouse.click(lines[y]!.indexOf("node_modules"), y));
    await send(() => setup.mockMouse.click(lines[y]!.indexOf("node_modules"), y));
    expect(focused).toBe(2);
    expect(toggles).toBe(0);
    await send(() => setup.mockMouse.click(x, y, 2));
    await send(() => setup.mockMouse.pressDown(x, y));
    expect(toggles).toBe(0);
    await send(() => setup.mockMouse.release(x, y));
    expect(toggles).toBe(1);
    await send(() => setup.mockMouse.drag(x, y, x + 1, y));
    expect(toggles).toBe(1);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("a narrow rendered pane keeps sizes visible beside CJK and emoji names", async () => {
  const candidates: ScanCandidate[] = ["東京の長い成果物".repeat(4), "👩🏽‍💻".repeat(8)].map(
    (name, i) => ({
      id: `wide-${i}`,
      name,
      path: `/owned/${name}`,
      kind: "dist",
      estimatedBytes: 512,
      entryType: "directory",
      isSymlink: false,
      riskTier: "safe",
      reasons: [],
      selectedByDefault: false,
    }),
  );
  const setup = await testRender(
    <ArtifactList
      rows={candidates.map((c) => ({ kind: "item", candidateId: c.id, groupLabel: "" }))}
      candidatesById={new Map(candidates.map((c) => [c.id, c]))}
      selectedIds={new Set()}
      currentRowIndex={0}
      focused
      tokens={darkTheme}
      paneWidth={30}
    />,
    { width: 30, height: 12 },
  );
  try {
    await act(async () => {
      await setup.renderOnce();
      await setup.flush();
    });
    const frame = setup.captureCharFrame();
    expect(frame.split("\n").filter((line) => line.includes("512 B"))).toHaveLength(2);
    expect(frame).toContain("東京");
    // The terminal sanitizer deliberately spells out ZWJ; width math includes it.
    expect(frame).toContain("👩🏽\\u");
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});

test("artifact hover survives an unchanged view and clears when its row is removed", async () => {
  const candidates = ["a", "b", "c"].map(
    (id): ScanCandidate => ({
      id,
      name: `modules-${id}`,
      path: `/tmp/hover/${id}`,
      kind: "node_modules",
      estimatedBytes: 1,
      entryType: "directory",
      isSymlink: false,
      riskTier: "safe",
      reasons: [],
      selectedByDefault: false,
    }),
  );
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const initial: UiDisplayRow[] = candidates
    .slice(0, 2)
    .map((c) => ({ kind: "item", candidateId: c.id, groupLabel: "" }));
  let change!: (rows?: UiDisplayRow[]) => void;
  function Fixture() {
    const [rows, setRows] = useState(initial);
    const [, repaint] = useState(0);
    change = (next) => {
      if (next) setRows(next);
      else repaint((n) => n + 1);
    };
    return (
      <box width="100%" height="100%">
        <ArtifactList
          rows={rows}
          candidatesById={byId}
          selectedIds={new Set()}
          currentRowIndex={0}
          focused
          tokens={darkTheme}
        />
      </box>
    );
  }
  const setup = await testRender(<Fixture />, { width: 80, height: 12 });
  const flush = async () => {
    await act(async () => {
      await setup.renderOnce();
      await setup.flush();
    });
  };
  const hovered = () => {
    const pending: BaseRenderable[] = [setup.renderer.root];
    let count = 0;
    while (pending.length) {
      const node = pending.pop()!;
      if (
        node instanceof BoxRenderable &&
        node.backgroundColor.equals(RGBA.fromHex(darkTheme.hoverBg))
      )
        count++;
      pending.push(...node.getChildren());
    }
    return count;
  };
  try {
    await flush();
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("modules-b"));
    expect(y).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await setup.mockMouse.moveTo(lines[y]!.indexOf("modules-b") + 1, y);
    });
    await flush();
    expect(hovered()).toBe(1);
    await act(async () => change());
    await flush();
    expect(hovered()).toBe(1);
    await act(async () => change([initial[0]!]));
    await flush();
    expect(hovered()).toBe(0);
  } finally {
    await act(async () => setup.renderer.destroy());
  }
});
