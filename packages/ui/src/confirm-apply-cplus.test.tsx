import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ApplyOverlay } from "./ApplyOverlay.js";
import { ConfirmOverlay } from "./ConfirmOverlay.js";
import { applyNotice } from "./presentation.js";
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
  await act(async () => {
    teardown?.();
  });
  teardown = null;
});

function expectFrameFits(frame: string, width: number, height: number) {
  const lines = frame.replace(/\n$/, "").split("\n");
  expect(lines.length).toBeLessThanOrEqual(height);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
}

async function render(node: React.ReactNode, width: number, height: number) {
  const setup = await testRender(node, { width, height });
  teardown = () => setup.renderer.destroy();
  await act(async () => {
    await setup.renderOnce();
  });
  return setup.captureCharFrame();
}

const previewItems = [
  {
    path: "apps/web/node_modules",
    bytes: 300 * 1024 ** 2,
    riskTier: "safe" as const,
    isSymlink: false,
  },
  {
    path: "crates/x/target",
    bytes: 90 * 1024 ** 2,
    riskTier: "caution" as const,
    isSymlink: false,
    bytesKnown: false,
  },
];

function confirmNode(overrides: Partial<Parameters<typeof ConfirmOverlay>[0]> = {}) {
  return (
    <ConfirmOverlay
      tokens={darkTheme}
      selectedCount={2}
      selectedBytes={390 * 1024 ** 2}
      dangerousCount={0}
      previewItems={previewItems}
      costShares={[
        { cost: "install", bytes: 300 * 1024 ** 2, how: "npm install" },
        { cost: "build", bytes: 90 * 1024 ** 2, how: "the project's build" },
      ]}
      disk={{ free: 12 * 1024 ** 3, total: 64 * 1024 ** 3 }}
      applyPolicy={{ maxSizeGB: 20, forceLarge: false }}
      onConfirm={() => {}}
      onCancel={() => {}}
      onToggleTrash={() => {}}
      canConfirm
      {...overrides}
    />
  );
}

describe("Direction C+ confirm dialog", () => {
  for (const [width, height] of VIEWPORTS) {
    test(`keeps the footer visible and the frame inside ${width}x${height}`, async () => {
      const frame = await render(confirmNode(), width, height);
      expectFrameFits(frame, width, height);
      expect(frame).toContain("Delete 2 items");
      expect(frame).toContain("390.0 MiB across 2 items");
      expect(frame).toContain("npm install");
      expect(frame).toContain("Size ceiling");
      expect(frame).not.toContain("before…");
      expect(frame).toContain("Move to trash instead");
      expect(frame).toContain("esc");
      if (width >= 80) {
        expect(frame).toContain("✓ apps/web/node_modules");
        expect(frame).toContain("~90.0 MiB");
      }
    });
  }

  test("uses sentence-case trash grammar instead of verb-first broken copy", async () => {
    const frame = await render(confirmNode({ trash: true }), 100, 32);
    expect(frame).toContain("Move 2 items to trash");
    expect(frame).not.toContain("Move to trash 2 items");
    expect(frame).toContain("restore manually");
  });

  test("always notes the ceiling but hides override while the queue is far below it", async () => {
    const frame = await render(
      confirmNode({
        selectedBytes: 1024 ** 2,
        selectedCount: 1,
        onOverrideSizeLimit: () => {},
      }),
      100,
      32,
    );
    expect(frame).toContain("Size ceiling: 20 GiB");
    expect(frame).not.toContain("Override ceiling");
  });

  test("offers the ceiling override when the reviewed bytes exceed it", async () => {
    const frame = await render(
      confirmNode({
        selectedBytes: 21 * 1024 ** 3,
        selectedCount: 1,
        previewItems: [previewItems[0]!],
        onOverrideSizeLimit: () => {},
      }),
      100,
      32,
    );
    expect(frame).toContain("exceeds by");
    expect(frame).toContain("Override ceiling");
  });

  test("NO_COLOR uses letter category fallbacks without dropping rebuild copy", async () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const frame = await render(confirmNode(), 100, 32);
      expect(frame).toContain("i install");
      expect(frame).toContain("b build");
      expect(frame).toContain("npm install");
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });

  for (const width of [80, 100] as const) {
    test(`danger warning wraps in full at ${width} cols`, async () => {
      const frame = await render(confirmNode({ dangerousCount: 1 }), width, 32);
      const normalized = frame.replace(/[│\s]+/g, " ");
      expect(normalized).toContain("⚠ 1 dangerous item selected · permanent deletion has no undo.");
      expect(frame).not.toContain("has no…");
    });
  }

  for (const width of [80, 100] as const) {
    test(`size-ceiling safety note wraps in full at ${width} cols`, async () => {
      const frame = await render(confirmNode({ applyPolicy: undefined }), width, 32);
      const normalized = frame.replace(/[│\s]+/g, " ");
      expect(normalized).toContain("No size ceiling · every path is checked again before removal.");
      expect(frame).not.toContain("before…");
    });
  }

  test("16-colour rendering still exposes the decisive copy", async () => {
    const previous = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const frame = await render(confirmNode({ dangerousCount: 1 }), 80, 24);
      expect(frame).toContain("Delete 2 items");
      expect(frame).toContain("permanent deletion");
    } finally {
      if (previous === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = previous;
    }
  });
});

describe("Direction C+ apply overlay", () => {
  for (const [width, height] of VIEWPORTS) {
    test(`uses one dot-matrix progress row at ${width}x${height}`, async () => {
      const frame = await render(
        <ApplyOverlay
          tokens={darkTheme}
          name="node_modules"
          targetDir="/tmp/work"
          trash={false}
          progress={{
            stage: "applying",
            selectedCount: 8,
            deletedCount: 3,
            estimatedBytesFreed: 128 * 1024 ** 2,
            elapsedMs: 12_300,
            removedEntries: 12_345,
            activePath: "/tmp/work/apps/web/node_modules",
          }}
          onCancel={() => {}}
          onToggleMotion={() => {}}
        />,
        width,
        height,
      );
      expectFrameFits(frame, width, height);
      expect(frame).toContain("Removing 8 queued items");
      expect(frame).toContain("37%");
      expect(frame).toContain("Completed");
      expect(frame).toContain("Freed");
      expect(frame).toContain("Elapsed");
      expect(frame).toContain("Stop after current item");
      expect(frame).not.toContain("Ctrl+C");
      const brailleRows = frame.split("\n").filter((line) => line.includes("⣿"));
      expect(brailleRows.length).toBe(1);
    });
  }

  test("stopping is explicit and amber-labelled rather than ambiguous", async () => {
    const frame = await render(
      <ApplyOverlay
        tokens={darkTheme}
        name="node_modules"
        targetDir="/tmp/work"
        trash={false}
        progress={{
          stage: "stopping",
          selectedCount: 8,
          deletedCount: 3,
          estimatedBytesFreed: 128 * 1024 ** 2,
          elapsedMs: 12_300,
        }}
        onCancel={() => {}}
      />,
      100,
      32,
    );
    expect(frame).toContain("Stopping removal");
    expect(frame).toContain("Stopping after current item");
    expect(frame).toContain("completed deletions stay removed");
    expect(frame).toContain("Stop requested");
  });

  test("completed backend operations stay pending until the authoritative final report", async () => {
    const frame = await render(
      <ApplyOverlay
        tokens={darkTheme}
        name="node_modules"
        targetDir="/tmp/work"
        trash={false}
        progress={{
          stage: "applying",
          selectedCount: 1,
          deletedCount: 1,
          estimatedBytesFreed: 1024,
          elapsedMs: 4_300,
          activePath: "/tmp/work/node_modules",
        }}
        onCancel={() => {}}
      />,
      100,
      32,
    );
    expect(frame).toContain("99%");
    expect(frame).toContain("Completed 1 of 1");
    expect(frame).toContain("waiting for the final report");
    expect(frame).not.toContain("100%");
  });
});

describe("apply receipts and partial failure notices", () => {
  test("drop whole lower-priority phrases before clipping any byte value or word", () => {
    const text = applyNotice({
      removed: 2,
      trash: false,
      freedBytes: 21.5 * 1024 ** 2,
      stillQueued: 7,
      failed: 1,
      unattempted: 3,
      stopped: false,
      firstFailure: "EACCES permission denied: locked-app/node_modules/deeply/nested/path",
      width: 46,
    });
    expect(text.length).toBeLessThanOrEqual(46);
    expect(text).not.toContain("…");
    expect(text).toContain("~21.5 MiB");
    expect(text).toContain("1 failed");
    expect(text).not.toMatch(/[KMGT]i…/);
  });

  test("failure detail truncates on the right instead of cutting through the error class", () => {
    const text = applyNotice({
      removed: 1,
      trash: false,
      freedBytes: 10 * 1024 ** 2,
      stillQueued: 0,
      failed: 1,
      unattempted: 0,
      stopped: false,
      firstFailure: "EACCES permission denied: locked-app/node_modules",
      width: 88,
    });
    expect(text.length).toBeLessThanOrEqual(88);
    expect(text).toContain("EACCES");
    expect(text).not.toContain("den…denied");
  });
});
