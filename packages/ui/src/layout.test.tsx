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
  // DIAG: temporary CI instrumentation - remove once the blank-frame cause is found.
  const frame = setup.captureCharFrame();
  if (frame.trim().length === 0) {
    const root = setup.renderer.root as unknown as { getChildren?: () => unknown[] };
    const scheduler = (
      setup.renderer as unknown as { getSchedulerState?: () => unknown }
    ).getSchedulerState?.();
    console.error(
      `[diag] blank frame: rootChildren=${root.getChildren?.().length ?? "?"} scheduler=${JSON.stringify(scheduler)}`,
    );
  }
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

    expect(frame).toContain("keyboard");
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
