import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SweepApp } from "./app.js";
import { ApplyOverlay } from "./ApplyOverlay.js";
import { MotionContext } from "./motion.js";
import { darkTheme, lightTheme } from "./theme.js";
import { REVIEW_FIXTURES, reviewFixture } from "./testing/review-fixtures.js";
import { releaseUiCaches } from "./state/store.js";
import { cellWidth } from "./text-cells.js";
import { KeyCodes } from "@opentui/core/testing";
import type { Renderable } from "@opentui/core";
import type { SweepUiOutcome } from "./outcome.js";

describe("native terminal worst-case review", () => {
  test("printable m remains filter text rather than an activity shortcut", async () => {
    const setup = await testRender(<SweepApp plan={reviewFixture("Demo")} onDone={() => {}} />, {
      width: 120,
      height: 24,
      exitOnCtrlC: false,
      exitSignals: [],
    });
    try {
      await act(async () => setup.renderOnce());
      await act(async () => {
        setup.mockInput.pressKey("/");
        await setup.flush();
      });
      await act(async () => {
        await setup.mockInput.typeText("modules");
        await setup.flush();
      });
      await act(async () => {
        await setup.renderOnce();
      });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("modules");
      expect(frame).not.toMatch(/Activity animation (paused|resumed)/);
      expect(frame).toContain("node_modules");
      expect(frame).not.toContain("target");
    } finally {
      await act(async () => setup.renderer.destroy());
      releaseUiCaches();
    }
  });

  test("empty, one, mixed Unicode/risk and 10k-row plans survive narrow and wide viewports", async () => {
    for (const width of [30, 40, 72, 120, 180]) {
      for (const mode of REVIEW_FIXTURES) {
        const outcomes: SweepUiOutcome[] = [];
        const setup = await testRender(
          <SweepApp
            plan={reviewFixture(mode)}
            dryRun
            onDone={(outcome) => outcomes.push(outcome)}
          />,
          {
            width,
            height: 16,
            exitOnCtrlC: false,
            exitSignals: [],
          },
        );
        try {
          // Mount first: the keyboard handler attaches on the first commit,
          // and a key pressed before it would be lost.
          await act(async () => {
            await setup.renderOnce();
          });
          await act(async () => {
            if (mode === "Huge") setup.mockInput.pressKey(KeyCodes.END);
            await setup.renderOnce();
          });
          // OpenTUI 0.6 paints a committed cursor move on the following frame.
          await act(async () => {
            await setup.renderOnce();
          });
          const frame = setup.captureCharFrame();
          expect(frame).toContain("artifacts");
          expect(frame).toContain("DRY RUN");
          expect(frame).not.toMatch(/NaN|undefined|\uFFFD/);
          expect(outcomes).toEqual([]);
          for (const line of frame.split("\n")) expect(cellWidth(line)).toBeLessThanOrEqual(width);
          if (mode === "Huge") {
            // End reached the last artifact: the cursor rail sits on the
            // list's bottom row, with only the context line and the
            // statusline below it.
            const lines = frame.split("\n");
            const cursorLine = lines.findIndex((line) => line.includes("\u258C"));
            expect(lines[cursorLine + 2]).toContain("NORMAL");
            const pending: Renderable[] = [setup.renderer.root];
            let mounted = 0;
            while (pending.length) {
              const node = pending.pop()!;
              mounted++;
              pending.push(...node.getChildren());
            }
            expect(mounted).toBeLessThan(500);
          }
          if (mode === "Empty") expect(frame).toContain("No artifacts");
        } finally {
          await act(async () => setup.renderer.destroy());
          releaseUiCaches();
        }
      }
    }
  });

  test("narrow inspector keeps actions outside scrolling and exposes long reasons", async () => {
    const plan = reviewFixture("Worst");
    plan.candidates[0]!.path = `${plan.targetDir}/${"customer-feedback-generated-output/".repeat(8)}reviewed-tail/node_modules`;
    const setup = await testRender(<SweepApp plan={plan} onDone={() => {}} />, {
      width: 30,
      height: 14,
      exitOnCtrlC: false,
    });
    try {
      await act(async () => {
        await setup.renderOnce();
      });
      await act(async () => {
        setup.mockInput.pressKey("i");
      });
      await act(async () => {
        await setup.renderOnce();
      });
      expect(setup.captureCharFrame()).toContain("Review removal");
      const seen: string[] = [];
      // Check each viewport, rather than only proving the text exists in JSX.
      for (let i = 0; i < 22; i++) {
        seen.push(setup.captureCharFrame());
        await act(async () => {
          setup.mockInput.pressKey("\x1b[6~");
          await setup.renderOnce();
        });
        expect(setup.captureCharFrame()).toContain("Esc Close");
      }
      const contents = seen
        .map((frame) =>
          frame
            .split("\n")
            .filter((line) => line.includes("│"))
            .map((line) => line.slice(line.indexOf("│") + 2, line.lastIndexOf("│")).trimEnd())
            .join(""),
        )
        .join("\n");
      expect(contents).toContain("reviewed-tail");
      expect(contents).toContain("explicit review.");
      await act(async () => {
        setup.mockInput.pressEscape();
        await setup.renderOnce();
      });
      expect(setup.captureCharFrame()).not.toContain("why it was flagged");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("paused apply retains progress and a working stop control in both themes", async () => {
    for (const tokens of [darkTheme, lightTheme]) {
      for (const width of [30, 72]) {
        let stopped = 0;
        const setup = await testRender(
          <MotionContext.Provider value={false}>
            <ApplyOverlay
              tokens={tokens}
              name="node_modules"
              targetDir={reviewFixture("One").targetDir}
              trash={false}
              progress={{
                stage: "applying",
                selectedCount: 2,
                deletedCount: 1,
                estimatedBytesFreed: 1024,
                elapsedMs: 12000,
                removedEntries: 1284,
              }}
              onCancel={() => {
                stopped++;
              }}
            />
          </MotionContext.Provider>,
          { width, height: 14 },
        );
        try {
          await setup.renderOnce();
          const frame = setup.captureCharFrame();
          expect(frame).toContain("m resume animation");
          expect(frame).toContain(width < 40 ? "Esc stop" : "Esc / Ctrl+C stop");
          const lines = frame.split("\n");
          const y = lines.findIndex((line) => line.includes("Esc"));
          const x = lines[y]!.indexOf("Esc");
          await act(async () => {
            await setup.mockMouse.click(x, y);
          });
          expect(stopped).toBe(1);
        } finally {
          await act(async () => setup.renderer.destroy());
        }
      }
    }
  });
});
