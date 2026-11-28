import { afterEach, describe, expect, test } from "bun:test";
import type { ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SweepApp } from "./app.js";
import {
  ConfigSaveModal,
  FolderInfoModal,
  PatternInfoModal,
  ScanErrorModal,
  UnavailableItemModal,
} from "./AppModals.js";
import { ProjectDetails } from "./ProjectDetails.js";
import { buildProjectRows, buildProjects } from "./projects.js";
import { ProjectsView } from "./ProjectsView.js";
import { darkTheme } from "./theme.js";
import { Modal, ModalFooter } from "./widgets.js";

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

function modalBoxLines(frame: string): string[] {
  return frame
    .split("\n")
    .filter((line) => line.includes("╭") || line.includes("│") || line.includes("╰"));
}

function expectFrameFits(frame: string, width: number, height: number) {
  const lines = frame.replace(/\n$/, "").split("\n");
  expect(lines.length).toBeLessThanOrEqual(height);
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(width);
  }
}

function makePlan(candidates: ScanCandidate[], targetDir = "/tmp/sweep-b1"): ScanPlan {
  return {
    protocolVersion: "1",
    targetDir,
    selectionPolicy: { mode: "default", includeDangerous: false },
    candidates,
    summary: {
      candidateCount: candidates.length,
      estimatedTotalBytes: candidates.reduce((sum, c) => sum + c.estimatedBytes, 0),
      scannedDirs: 12,
      exact: true,
      selectedCount: 0,
      riskCounts: {
        safe: candidates.filter((c) => c.riskTier === "safe").length,
        caution: candidates.filter((c) => c.riskTier === "caution").length,
        dangerous: candidates.filter((c) => c.riskTier === "dangerous").length,
        blocked: candidates.filter((c) => c.riskTier === "blocked").length,
      },
    },
    selectedCandidateIds: [],
    createdAt: new Date().toISOString(),
  };
}

describe("shared Modal shell and ModalFooter (B2)", () => {
  for (const [width, height] of VIEWPORTS) {
    test(`short auto-height modal hugs its content at ${width}x${height}`, async () => {
      const setup = await testRender(
        <Modal
          tokens={darkTheme}
          title="  Pattern details  "
          width={60}
          footer={<ModalFooter tokens={darkTheme} actions={[{ key: "esc", label: "close" }]} />}
        >
          <text content="node_modules" fg={darkTheme.text} wrapMode="word" />
          <text
            content="Matches artifact names inside the scanned tree."
            fg={darkTheme.textMuted}
            wrapMode="word"
          />
        </Modal>,
        { width, height },
      );
      teardown = () => setup.renderer.destroy();
      await act(async () => {
        await setup.renderOnce();
      });
      const frame = setup.captureCharFrame();
      expectFrameFits(frame, width, height);
      const box = modalBoxLines(frame);
      // Border (2) + padY (2) + 2 body lines + marginTop (1) + hairline (1) + footer (1) = 9 rows
      // (up to 11 if text wraps at 60 cols). Must never stretch to viewport height.
      expect(box.length).toBeGreaterThanOrEqual(7);
      expect(box.length).toBeLessThanOrEqual(12);
      expect(box.length).toBeLessThan(height - 4);
      // Normalized 1-space title padding, Sentence case.
      expect(frame).toContain("╭─ Pattern details ─");
      expect(frame).toContain(" esc  close");
    });

    test(`long auto-height modal caps at maxHeight and scrolls internally at ${width}x${height}`, async () => {
      const setup = await testRender(
        <Modal
          tokens={darkTheme}
          title="Long content"
          width={60}
          footer={<ModalFooter tokens={darkTheme} actions={[{ key: "esc", label: "close" }]} />}
        >
          {Array.from({ length: 45 }, (_, i) => (
            <text
              key={`row-${i}`}
              content={`Entry line ${String(i + 1).padStart(2, "0")}`}
              fg={darkTheme.text}
              wrapMode="word"
            />
          ))}
        </Modal>,
        { width, height },
      );
      teardown = () => setup.renderer.destroy();
      await act(async () => {
        await setup.renderOnce();
      });
      const initial = setup.captureCharFrame();
      expectFrameFits(initial, width, height);
      const box = modalBoxLines(initial);
      expect(box.length).toBeLessThanOrEqual(height - 4);
      expect(initial).toContain("Entry line 01");
      expect(initial).toContain(" esc  close");

      if (height < 55) {
        expect(initial).not.toContain("Entry line 45");
        await act(async () => {
          setup.mockInput.pressKey("\x1b[6~"); // PageDown
          await setup.flush();
        });
        await act(async () => {
          await setup.renderOnce();
        });
        const scrolled = setup.captureCharFrame();
        expect(scrolled).toContain(" esc  close");
        expect(scrolled).not.toContain("Entry line 01");
      }
    });
  }

  test("ModalFooter buttons are content-sized, clickable, and respect disabled state", async () => {
    let saved = 0;
    let cancelled = 0;
    const setup = await testRender(
      <Modal
        tokens={darkTheme}
        title="Save cleanup patterns?"
        width={60}
        footer={
          <ModalFooter
            tokens={darkTheme}
            actions={[
              {
                key: "y",
                label: "save patterns",
                primary: true,
                disabled: true,
                onPress: () => {
                  saved += 1;
                },
              },
              {
                key: "n / esc",
                label: "cancel",
                onPress: () => {
                  cancelled += 1;
                },
              },
            ]}
          />
        }
      >
        <text content="Body text" fg={darkTheme.text} />
      </Modal>,
      { width: 80, height: 24 },
    );
    teardown = () => setup.renderer.destroy();
    await act(async () => {
      await setup.renderOnce();
    });
    const lines = setup.captureCharFrame().split("\n");
    const footerY = lines.findIndex((line) => line.includes(" y  save patterns"));
    expect(footerY).toBeGreaterThanOrEqual(0);
    // Both actions sit on the same horizontal row, sized to their own labels.
    expect(lines[footerY]).toContain(" n / esc  cancel");

    await act(async () => {
      await setup.mockMouse.click(lines[footerY]!.indexOf(" y  save patterns") + 1, footerY);
      await setup.flush();
    });
    expect(saved).toBe(0);

    await act(async () => {
      await setup.mockMouse.click(lines[footerY]!.indexOf(" n / esc  cancel") + 1, footerY);
      await setup.flush();
    });
    expect(cancelled).toBe(1);
  });

  test("all five small modals hug content with Sentence-case titles and C+ ModalFooter across viewports", async () => {
    const cases: Array<{
      name: string;
      title: string;
      keyHint: string;
      render: () => React.ReactNode;
    }> = [
      {
        name: "ScanErrorModal",
        title: "Scan failed",
        keyHint: " r  retry scan",
        render: () => <ScanErrorModal tokens={darkTheme} message="error: permission denied" />,
      },
      {
        name: "UnavailableItemModal",
        title: "Item unavailable",
        keyHint: " n / esc  close",
        render: () => <UnavailableItemModal tokens={darkTheme} />,
      },
      {
        name: "FolderInfoModal",
        title: "Folder details",
        keyHint: " esc  close",
        render: () => (
          <FolderInfoModal
            tokens={darkTheme}
            folderInfo={{ path: "/tmp/workspace/app", count: 4, queued: 1, scanning: false }}
            onClose={() => {}}
          />
        ),
      },
      {
        name: "PatternInfoModal",
        title: "Pattern details",
        keyHint: " esc  close",
        render: () => (
          <PatternInfoModal tokens={darkTheme} pattern="node_modules" onClose={() => {}} />
        ),
      },
      {
        name: "ConfigSaveModal",
        title: "Save cleanup patterns?",
        keyHint: " y  save patterns",
        render: () => (
          <ConfigSaveModal
            tokens={darkTheme}
            configSave={{
              path: "/tmp/workspace/.sweeprc",
              delta: { patterns: [".cache"], disabledPatterns: [] },
              revision: "rev1",
            }}
            canConfirm
            onConfirm={() => {}}
            onCancel={() => {}}
          />
        ),
      },
    ];

    for (const entry of cases) {
      for (const [width, height] of VIEWPORTS) {
        const setup = await testRender(entry.render(), { width, height });
        teardown = () => setup.renderer.destroy();
        await act(async () => {
          await setup.renderOnce();
        });
        const frame = setup.captureCharFrame();
        expectFrameFits(frame, width, height);
        expect(frame, `${entry.name} ${width}x${height}`).toContain(`╭─ ${entry.title} ─`);
        expect(frame, `${entry.name} ${width}x${height}`).toContain(entry.keyHint);
        const box = modalBoxLines(frame);
        // Never expand into an empty viewport cavern at 100x32, 120x34, or 200x60.
        if (height >= 24) {
          expect(box.length, `${entry.name} ${width}x${height}`).toBeLessThanOrEqual(16);
        }
        await act(async () => {
          teardown?.();
        });
        teardown = null;
      }
    }
  });
});

describe("Batch 1 layout and trust bug fixes", () => {
  test("B1: Patterns pane statusline never collides or clips mid-word at 60, 80, 100, and 120 cols", async () => {
    const plan = makePlan([
      {
        id: "c1",
        path: "/tmp/sweep-b1/app/node_modules",
        name: "node_modules",
        kind: "node_modules",
        estimatedBytes: 1024 * 1024,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: false,
      },
    ]);

    for (const [width, height] of [
      [60, 20],
      [80, 24],
      [100, 32],
      [120, 34],
    ] as const) {
      const setup = await testRender(
        <SweepApp init={{ startUnselected: true }} plan={plan} onDone={() => {}} />,
        { width, height },
      );
      teardown = () => setup.renderer.destroy();
      await act(async () => {
        await setup.renderOnce();
        await setup.flush();
      });
      await act(async () => {
        setup.mockInput.pressKey("p");
        await setup.flush();
      });
      await act(async () => {
        await setup.renderOnce();
      });

      const frame = setup.captureCharFrame();
      expectFrameFits(frame, width, height);
      const statusLine = frame.replace(/\n$/, "").split("\n").at(-1) ?? "";
      expect(statusLine, `width=${width}`).toContain("PATTERNS");
      expect(statusLine, `width=${width}`).toContain(" esc  back");
      // Action hints outrank passive "queue empty": at 100 and 120 cols with an empty queue,
      // both `/ find` and `d del custom` remain visible without colliding.
      if (width >= 100) {
        expect(statusLine, `width=${width}`).toContain(" /  find");
        expect(statusLine, `width=${width}`).toContain(" d  del custom");
        expect(statusLine, `width=${width}`).not.toContain("queue empty");
      }
      // Never collide left hints into right tally or clip .sweeprc mid-word.
      expect(frame, `width=${width}`).not.toContain("queuenem");
      expect(frame, `width=${width}`).not.toMatch(/save \.swe(?!eprc)/);
      expect(frame, `width=${width}`).not.toMatch(/\.sweep(?!rc)/);
      await act(async () => {
        teardown?.();
      });
      teardown = null;
    }
  });

  test("B4: No activity found projects show ? (never cyan now) and unknown in ProjectDetails", async () => {
    const now = Date.parse("2026-11-28T12:00:00Z");
    const orphan: ScanCandidate = {
      id: "orphan-1",
      path: "/tmp/sweep-b1/orphan-artifacts-only/node_modules",
      name: "node_modules",
      kind: "node_modules",
      estimatedBytes: 12 * 1024 * 1024,
      bytesKnown: true,
      modifiedMs: now - 1000, // Recent artifact mtime, NO projectActiveMs!
      isSymlink: false,
      entryType: "directory",
      riskTier: "safe",
      reasons: ["default-pattern"],
      selectedByDefault: true,
      projectRoot: "/tmp/sweep-b1/orphan-artifacts-only",
    };

    const projects = buildProjects([orphan], new Set(), "/tmp/sweep-b1", now);
    expect(projects[0]?.section).toBe("unknown");
    expect(projects[0]?.activeMs).toBeUndefined();

    const rows = buildProjectRows(projects, new Set());
    const setup = await testRender(
      <ProjectsView
        tokens={darkTheme}
        width={120}
        height={24}
        target="/tmp/sweep-b1"
        rows={rows}
        cursor={1}
        now={now}
        scanning={false}
        sizedLabel=""
        reclaimableBytes={projects[0]!.queueableBytes}
        idleBytes={0}
        projectCount={1}
        selectedBytes={0}
        selectedCount={0}
        selectedIds={new Set()}
        diskFree={null}
        filter=""
        searchFocused={false}
        footer={<text content="" />}
        onFilterInput={() => {}}
        onFilterSubmit={() => {}}
        onRowPress={() => {}}
        onCursorDelta={() => {}}
      />,
      { width: 120, height: 24 },
    );
    teardown = () => setup.renderer.destroy();
    await act(async () => {
      await setup.renderOnce();
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("No activity found");
    const rowLine =
      frame
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => line.slice(0, 74))
        .find((left) => left.includes("orphan-artifacts-only")) ?? "";
    expect(rowLine).toContain("?");
    expect(rowLine).not.toMatch(/\bnow\b/);
    // Details margin beside ProjectsView must also say unknown, not "just now".
    expect(frame).toContain("worked on  unknown");
    expect(frame).not.toContain("just now");

    await act(async () => {
      teardown?.();
    });
    teardown = null;

    const detailsSetup = await testRender(
      <ProjectDetails
        project={projects[0]!}
        selectedIds={new Set()}
        tokens={darkTheme}
        width={44}
        height={24}
        now={now}
      />,
      { width: 44, height: 24 },
    );
    teardown = () => detailsSetup.renderer.destroy();
    await act(async () => {
      await detailsSetup.renderOnce();
    });
    const detailsFrame = detailsSetup.captureCharFrame();
    expect(detailsFrame).toContain("worked on  unknown");
    expect(detailsFrame).not.toContain("just now");
  });

  test("B5: Full View renders explicit group headers for single-artifact folders (UX §9)", async () => {
    const plan = makePlan([
      {
        id: "m1",
        path: "/tmp/sweep-b1/old-cli/node_modules",
        name: "node_modules",
        kind: "node_modules",
        estimatedBytes: 40 * 1024 * 1024,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: false,
      },
      {
        id: "m2",
        path: "/tmp/sweep-b1/old-cli/.turbo",
        name: ".turbo",
        kind: ".turbo",
        estimatedBytes: 4 * 1024 * 1024,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: false,
      },
      {
        id: "s1",
        path: "/tmp/sweep-b1/core-api/target",
        name: "target",
        kind: "target",
        estimatedBytes: 20 * 1024 * 1024,
        isSymlink: false,
        entryType: "directory",
        riskTier: "safe",
        reasons: ["default-pattern"],
        selectedByDefault: false,
      },
      {
        id: "s2",
        path: "/tmp/sweep-b1/orphan-only/dist",
        name: "dist",
        kind: "dist",
        estimatedBytes: 5 * 1024 * 1024,
        isSymlink: false,
        entryType: "directory",
        riskTier: "caution",
        reasons: ["default-pattern"],
        selectedByDefault: false,
      },
    ]);

    const setup = await testRender(
      <SweepApp init={{ startUnselected: true }} plan={plan} onDone={() => {}} />,
      { width: 120, height: 34 },
    );
    teardown = () => setup.renderer.destroy();
    await act(async () => {
      await setup.renderOnce();
      await setup.flush();
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("▾ old-cli/");
    expect(frame).toContain("▾ core-api/");
    expect(frame).toContain("▾ orphan-only/");
  });

  test("B11: Full View live scan does not print 'No matching artifacts.' above SCANNING", async () => {
    const emptyPlan = makePlan([]);
    const pendingScan = {
      rescan: () => new Promise<never>(() => {}),
    };
    const setup = await testRender(
      <SweepApp
        init={{ startUnselected: true }}
        plan={emptyPlan}
        scan={pendingScan as never}
        initiallyScanning
        onDone={() => {}}
      />,
      { width: 120, height: 34 },
    );
    teardown = () => setup.renderer.destroy();
    await act(async () => {
      await setup.renderOnce();
      await setup.flush();
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("SCANNING");
    expect(frame).toContain("Scanning for artifacts…");
    expect(frame).not.toContain("No matching artifacts.");
  });

  test("B12: Empty Full View sidebar never truncates 'All folders' to 'All f…ders'", async () => {
    const emptyPlan = makePlan([]);
    for (const [width, height] of [
      [80, 24],
      [100, 32],
      [120, 34],
    ] as const) {
      const setup = await testRender(
        <SweepApp init={{ startUnselected: true }} plan={emptyPlan} onDone={() => {}} />,
        { width, height },
      );
      teardown = () => setup.renderer.destroy();
      await act(async () => {
        await setup.renderOnce();
        await setup.flush();
      });
      const frame = setup.captureCharFrame();
      expectFrameFits(frame, width, height);
      expect(frame, `width=${width}`).toContain("All folders");
      expect(frame, `width=${width}`).not.toContain("All f…ders");
      await act(async () => {
        teardown?.();
      });
      teardown = null;
    }
  });
});
