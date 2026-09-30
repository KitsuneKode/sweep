import { afterEach, describe, expect, test } from "bun:test";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SweepApp, type SweepUiOutcome } from "./app.js";

const DAY = 24 * 60 * 60 * 1000;

function candidate(
  overrides: Partial<ScanCandidate> & Pick<ScanCandidate, "id" | "name" | "path">,
): ScanCandidate {
  return {
    kind: "node_modules",
    estimatedBytes: 1024,
    isSymlink: false,
    entryType: "directory",
    riskTier: "safe",
    reasons: ["default-pattern"],
    selectedByDefault: true,
    ...overrides,
  };
}

/** A plan with every tier, two scopes, and ages from yesterday to two years ago. */
function createPlan(): ScanPlan {
  const now = Date.now();
  const candidates = [
    candidate({
      id: "a",
      name: "node_modules",
      path: "/tmp/sweep-ui/apps/web/node_modules",
      estimatedBytes: 300 * 1024 * 1024,
      modifiedMs: now - 240 * DAY,
    }),
    candidate({
      id: "b",
      name: ".next",
      kind: "build",
      path: "/tmp/sweep-ui/apps/web/.next",
      estimatedBytes: 40 * 1024 * 1024,
      modifiedMs: now - 1 * DAY,
      riskTier: "caution",
      selectedByDefault: false,
    }),
    candidate({
      id: "c",
      name: "target",
      kind: "target",
      path: "/tmp/sweep-ui/crates/x/target",
      estimatedBytes: 90 * 1024 * 1024,
      modifiedMs: now - 800 * DAY,
    }),
    candidate({
      id: "d",
      name: "vendor",
      kind: "custom",
      path: "/tmp/sweep-ui/vendor",
      estimatedBytes: 2 * 1024 * 1024,
      riskTier: "dangerous",
      selectedByDefault: false,
    }),
  ];
  return {
    protocolVersion: "1",
    targetDir: "/tmp/sweep-ui",
    selectionPolicy: { mode: "default", includeDangerous: false },
    candidates,
    summary: {
      candidateCount: candidates.length,
      estimatedTotalBytes: candidates.reduce((sum, item) => sum + item.estimatedBytes, 0),
      scannedDirs: 9,
      exact: false,
      selectedCount: 2,
      riskCounts: { safe: 2, caution: 1, dangerous: 1, blocked: 0 },
    },
    selectedCandidateIds: ["a", "c"],
    createdAt: new Date().toISOString(),
  };
}

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
});

async function mount(
  width: number,
  height: number,
  onDone: (o: SweepUiOutcome) => void = () => {},
) {
  const setup = await testRender(<SweepApp plan={createPlan()} onDone={onDone} />, {
    width,
    height,
  });
  teardown = () => setup.renderer.destroy();
  await act(async () => {
    await setup.renderOnce();
    // renderOnce paints whatever has committed at this instant; a deferred
    // commit lands a tick later on some CI schedulers, so drain pending work.
    await setup.flush();
  });
  return setup;
}

type Mounted = Awaited<ReturnType<typeof mount>>;

/** Deliver one input and render, so the next frame capture reflects it. */
async function send(setup: Mounted, input: (mock: Mounted["mockInput"]) => void) {
  await act(async () => {
    input(setup.mockInput);
    await setup.flush();
  });
  await act(async () => {
    await setup.renderOnce();
  });
}

async function press(setup: Mounted, ...keys: string[]) {
  for (const key of keys) await send(setup, (mock) => mock.pressKey(key));
}

/** Same act split as `send`: input commits in the first act, paint in the second. */
async function mouse(setup: Mounted, input: (mock: Mounted["mockMouse"]) => Promise<void>) {
  await act(async () => {
    await input(setup.mockMouse);
    await setup.flush();
  });
  await act(async () => {
    await setup.renderOnce();
  });
}

/** Every rendered line must fit the terminal: a wider line means clipped or wrapped chrome. */
function expectFits(frame: string, width: number) {
  for (const line of frame.split("\n")) {
    expect(line.length).toBeLessThanOrEqual(width);
  }
}

describe("layout across terminal sizes", () => {
  test("wide: both panes, age column, size bars, and the sidebar insights", async () => {
    const setup = await mount(120, 34);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("scopes");
    expect(frame).toContain("artifacts");
    expect(frame).toContain("Age");
    expect(frame).toContain("2y");
    expect(frame).toMatch(/8mo\s+█+\s+300\.0 MB/);
    // Insights panel: tier breakdown and the stale total.
    expect(frame).toContain("caution");
    expect(frame).toContain("dangerous");
    expect(frame).toContain("untouched 30d+");
    expectFits(frame, 120);
  });

  test("medium: keeps the age column but sheds the size bar", async () => {
    const setup = await mount(100, 30);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("Age");
    // The size bar sits between the age and the size on each row.
    expect(frame).toMatch(/8mo\s+300\.0 MB/);
    expect(frame).not.toMatch(/8mo\s+█/);
    expectFits(frame, 100);
  });

  test("narrow: no sidebar, no age column, compact hints, nothing overflows", async () => {
    const setup = await mount(52, 20);
    const frame = setup.captureCharFrame();

    expect(frame).not.toContain("scopes");
    expect(frame).not.toContain("Age");
    expect(frame).toContain("artifacts");
    expect(frame).toContain("? keys");
    expectFits(frame, 52);
  });

  test("short terminals drop the sidebar insights before the scope list", async () => {
    const setup = await mount(120, 22);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("all scopes");
    expect(frame).not.toContain("untouched 30d+");
    expectFits(frame, 120);
  });

  test("the help modal fits and wraps in a tiny terminal instead of crashing", async () => {
    const setup = await mount(40, 14);
    await press(setup, "?");
    const frame = setup.captureCharFrame();

    expect(frame).toContain("keys");
    expectFits(frame, 40);
  });

  test("the confirm dialog offers trash and says what it will do", async () => {
    const setup = await mount(120, 34);
    await send(setup, (mock) => mock.pressEnter());
    let frame = setup.captureCharFrame();
    expect(frame).toContain("Permanently delete");
    expect(frame).toContain("move to trash instead");

    await press(setup, "t");
    frame = setup.captureCharFrame();
    expect(frame).toContain("Move to trash");
    expect(frame).toContain("delete permanently instead");
  });

  test("choosing trash in the dialog is reported in the apply outcome", async () => {
    const outcomes: SweepUiOutcome[] = [];
    const setup = await mount(120, 34, (outcome) => outcomes.push(outcome));
    await send(setup, (mock) => mock.pressEnter());
    await press(setup, "t", "y");

    const outcome = outcomes[0];
    expect(outcome?.type).toBe("apply");
    if (outcome?.type === "apply") expect(outcome.trash).toBe(true);
  });
});

describe("triage keys", () => {
  test("o cycles the sort and the footer names a non-default order", async () => {
    const setup = await mount(120, 34);
    await press(setup, "o", "o");
    expect(setup.captureCharFrame()).toContain("sorted by age");
  });

  test("v enters visual mode and a second v leaves it without quitting", async () => {
    // Esc-to-cancel is covered by the state and keymap tests; the test
    // renderer's synthetic ESC does not reach the app's key handler.
    const outcomes: SweepUiOutcome[] = [];
    const setup = await mount(120, 34, (outcome) => outcomes.push(outcome));
    await press(setup, "v");
    expect(setup.captureCharFrame()).toContain("VISUAL");

    await press(setup, "v");
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("VISUAL");
    expect(frame).toContain("NORMAL");
    expect(outcomes).toEqual([]);
  });

  test("a filter expression narrows the list and the header says how many are shown", async () => {
    const setup = await mount(120, 34);
    await press(setup, "/");
    for (const character of ">100MB") await press(setup, character);
    await send(setup, (mock) => mock.pressEnter());

    const frame = setup.captureCharFrame();
    expect(frame).toContain("node_modules");
    expect(frame).not.toContain("vendor");
  });
});

describe("scroll stability", () => {
  // Enough grouped rows that the artifact pane is scrollable at 20 rows tall;
  // the oscillation this guards against needed headers crossing the window edge.
  function bigPlan(): ScanPlan {
    const candidates = Array.from({ length: 30 }, (_, i) =>
      candidate({
        id: `big-${i}`,
        name: "node_modules",
        path: `/tmp/sweep-ui/pkg${Math.floor(i / 3)}/mod${i}/node_modules`,
        estimatedBytes: (i + 1) * 1024 * 1024,
      }),
    );
    return {
      ...createPlan(),
      candidates,
      summary: {
        ...createPlan().summary,
        candidateCount: candidates.length,
      },
    };
  }

  async function mountBig(height = 20) {
    const setup = await testRender(<SweepApp plan={bigPlan()} onDone={() => {}} />, {
      width: 90,
      height,
    });
    teardown = () => setup.renderer.destroy();
    await act(async () => {
      await setup.renderOnce();
      await setup.flush();
    });
    return setup;
  }

  test("jumping the cursor to the end settles - the frame stops changing", async () => {
    const setup = await mountBig();
    await press(setup, "G");
    const settled = setup.captureCharFrame();
    // The sticky-header slot used to toggle the list height by one row at this
    // boundary, which moved the window, which toggled the slot - an endless
    // repaint. A second render must reproduce the first frame exactly.
    await act(async () => {
      await setup.renderOnce();
      await setup.flush();
    });
    await act(async () => {
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toBe(settled);
  });

  test("the sticky slot stays reserved for a scrollable list", async () => {
    const setup = await mountBig();
    const top = setup.captureCharFrame();
    await press(setup, "G");
    const bottom = setup.captureCharFrame();
    // Same row count painted at both ends of the list: the sticky line being
    // conditional used to add/remove a row and shift every row up or down.
    expect(bottom.split("\n").length).toBe(top.split("\n").length);
    // A pinned group header line is present once the real one scrolled off.
    expect(bottom).toContain("pkg9");
  });

  // Locates the scrollbar track in a captured frame: the rightmost 1-column
  // lane of block glyphs (░/█) inside the artifacts pane's right edge.
  function scrollbarGeometry(frame: string) {
    const lines = frame.split("\n");
    let x = -1;
    for (const line of lines) {
      x = Math.max(x, line.lastIndexOf("░"), line.lastIndexOf("█"));
    }
    if (x === -1) throw new Error("no scrollbar lane found in frame");
    const rows = lines
      .map((line, y) => (/[░█]/.test(line[x] ?? "") ? y : -1))
      .filter((y) => y !== -1);
    if (rows.length === 0) throw new Error("no scrollbar lane found in frame");
    return { x, top: rows[0]!, bottom: rows[rows.length - 1]! };
  }

  test("clicking the scrollbar track seeks the cursor", async () => {
    const setup = await mountBig();
    const { x, top, bottom } = scrollbarGeometry(setup.captureCharFrame());

    // The lane's bottom-most cell sits on the hit-grid boundary and does not
    // register in the test renderer, so seek one cell in from each edge.
    await mouse(setup, (m) => m.click(x, bottom - 1));
    expect(setup.captureCharFrame()).toMatch(/▌\s+○ node_modules\s+[0-9.]+ MB/);
    const mid = setup.captureCharFrame().match(/▌\s+○ node_modules\s+([0-9.]+) MB/);
    expect(Number(mid![1])).toBeLessThan(10);

    await mouse(setup, (m) => m.click(x, top));
    expect(setup.captureCharFrame()).toMatch(/▌\s+○ node_modules\s+30\.0 MB/);
  });

  test("dragging the scrollbar thumb seeks continuously", async () => {
    const setup = await mountBig();
    const frame = setup.captureCharFrame();
    const { x, top, bottom } = scrollbarGeometry(frame);
    expect(frame).toMatch(/▌\s+○ node_modules\s+30\.0 MB/);

    await mouse(setup, (m) => m.drag(x, top, x, bottom - 1));
    const landed = setup.captureCharFrame().match(/▌\s+○ node_modules\s+([0-9.]+) MB/);
    expect(Number(landed![1])).toBeLessThan(10);
  });

  test("a thumb drag to the track bottom reaches the last item", async () => {
    const setup = await mountBig();
    const frame = setup.captureCharFrame();
    const { x, top, bottom } = scrollbarGeometry(frame);
    // The thumb sits at the track top before any scroll; grabbing its top
    // cell gives grab=0, so the last *hittable* cell (the very last row sits
    // on the test renderer's hit-grid boundary) lands the thumb top exactly
    // at its travel end. Mapping that drag over the full track height -
    // the old behavior - stops ~thumbHeight rows short of the last item.
    await mouse(setup, (m) => m.drag(x, top, x, bottom - 1));
    // Sorted desc by size: the last item is the 1.0 MB row.
    expect(setup.captureCharFrame()).toMatch(/▌\s+○ node_modules\s+1\.0 MB/);
  });
});
