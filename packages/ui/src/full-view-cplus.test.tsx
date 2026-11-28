import { afterEach, describe, expect, test } from "bun:test";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SweepApp } from "./app.js";
import { artifactRowWidths, buildArtifactRowContent } from "./presentation.js";
import { darkTheme } from "./theme.js";

const VIEWPORTS = [
  [60, 20],
  [80, 24],
  [100, 32],
  [120, 34],
  [200, 60],
] as const;

let teardown: (() => void) | null = null;
afterEach(async () => {
  await act(async () => teardown?.());
  teardown = null;
});

function candidate(
  overrides: Partial<ScanCandidate> & Pick<ScanCandidate, "id" | "name" | "path">,
): ScanCandidate {
  return {
    kind: "custom",
    estimatedBytes: 1024,
    isSymlink: false,
    entryType: "directory",
    riskTier: "safe",
    reasons: ["default-pattern"],
    selectedByDefault: false,
    ...overrides,
  };
}

function plan(): ScanPlan {
  const candidates = [
    candidate({
      id: "install",
      name: "node_modules",
      kind: "node_modules",
      path: "/tmp/sweep-cplus-full/app/node_modules",
      estimatedBytes: 151 * 1024 * 1024,
      selectedByDefault: true,
    }),
    candidate({
      id: "build",
      name: ".next",
      kind: ".next",
      path: "/tmp/sweep-cplus-full/app/.next",
      estimatedBytes: 40 * 1024 * 1024 + (1024 * 1024) / 10,
      riskTier: "caution",
    }),
    candidate({
      id: "cache",
      name: ".turbo",
      kind: ".turbo",
      path: "/tmp/sweep-cplus-full/api/.turbo",
      estimatedBytes: 7 * 1024 * 1024,
    }),
  ];
  return {
    protocolVersion: "1",
    targetDir: "/tmp/sweep-cplus-full",
    createdAt: new Date().toISOString(),
    selectionPolicy: { mode: "default", includeDangerous: false },
    candidates,
    selectedCandidateIds: ["install"],
    summary: {
      candidateCount: candidates.length,
      selectedCount: 1,
      estimatedTotalBytes: candidates.reduce((sum, c) => sum + c.estimatedBytes, 0),
      scannedDirs: 4,
      exact: true,
      riskCounts: { safe: 2, caution: 1, dangerous: 0, blocked: 0 },
    },
  };
}

function expectFits(frame: string, width: number) {
  for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
}

async function mount(width: number, height: number) {
  const setup = await testRender(
    <SweepApp init={{ startUnselected: false }} plan={plan()} onDone={() => {}} />,
    { width, height },
  );
  teardown = () => setup.renderer.destroy();
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  return setup;
}

async function press(setup: Awaited<ReturnType<typeof mount>>, key: string) {
  await act(async () => {
    setup.mockInput.pressKey(key);
    await setup.flush();
  });
  await act(async () => setup.renderOnce());
}

describe("Direction C+ full view", () => {
  for (const [width, height] of VIEWPORTS) {
    test(`compact ledger, headed rows, cost dots, spaced units and calm footer fit ${width}x${height}`, async () => {
      const setup = await mount(width, height);
      const frame = setup.captureCharFrame();
      expectFits(frame, width);
      expect(frame).toContain("reclaimable");
      expect(frame).toContain("node_modules");
      expect(frame).toMatch(/✓\s+●\s+node_modules/);
      expect(frame).toContain("MiB");
      expect(frame).not.toMatch(/\d(?:\.\d)?(?:KiB|MiB|GiB)\b/);
      expect(frame).not.toContain(" NORMAL ");
      expect(frame).not.toContain("Actions Ctrl+K");
      if (width >= 54) expect(frame).toContain("review (1)");
      if (width >= 64) expect(frame).toContain("queue safe");
      if (width >= 80) expect(frame).toContain("All folders");
      await act(async () => setup.renderer.destroy());
      teardown = null;
    });
  }

  test("patterns use filled/open rings, cost glyphs and keycap toolbar actions", async () => {
    const setup = await mount(100, 32);
    await press(setup, "p");
    const frame = setup.captureCharFrame();
    expectFits(frame, 100);
    expect(frame).toContain("find");
    expect(frame).toContain("add");
    expect(frame).toContain("save");
    expect(frame).not.toContain("[x]");
    expect(frame).not.toContain("[ ]");
    expect(frame).toMatch(/[●○]\s+[●cib?]\s+node_modules/);
  });

  test("NO_COLOR rows keep a one-cell cost-category letter", () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const line = buildArtifactRowContent(
        plan().candidates[0]!,
        false,
        false,
        artifactRowWidths(80),
        darkTheme,
        "/tmp/sweep-cplus-full",
      )
        .chunks.map((chunk) => chunk.text)
        .join("");
      expect(line).toMatch(/✓\s+i\s+node_modules/);
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });

  test("16-colour rendering keeps the full-view structure readable", async () => {
    const previous = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const setup = await mount(100, 32);
      const frame = setup.captureCharFrame();
      expectFits(frame, 100);
      expect(frame).toContain("reclaimable");
      expect(frame).toContain("node_modules");
      expect(frame).not.toContain(" NORMAL ");
      await act(async () => setup.renderer.destroy());
      teardown = null;
    } finally {
      if (previous === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = previous;
    }
  });
});
