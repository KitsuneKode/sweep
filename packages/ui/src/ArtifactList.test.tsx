import { expect, test } from "bun:test";
import { BoxRenderable, RGBA, type BaseRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { ArtifactList } from "./ArtifactList.js";
import type { UiDisplayRow } from "./rows.js";
import { darkTheme } from "./theme.js";

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
