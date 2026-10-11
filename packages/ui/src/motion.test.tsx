import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { motionEnabledFromEnvironment, MotionContext } from "./motion.js";
import { DotStrip, useDotFrame } from "./widgets.js";
import { darkTheme } from "./theme.js";

const original = process.env.SWEEP_REDUCED_MOTION;
afterEach(() => {
  if (original === undefined) delete process.env.SWEEP_REDUCED_MOTION;
  else process.env.SWEEP_REDUCED_MOTION = original;
});

describe("terminal motion preference", () => {
  test("recognizes explicit reduced-motion preferences", () => {
    for (const value of ["1", "true", "TRUE"]) {
      process.env.SWEEP_REDUCED_MOTION = value;
      expect(motionEnabledFromEnvironment()).toBe(false);
    }
    for (const value of ["0", "false", ""]) {
      process.env.SWEEP_REDUCED_MOTION = value;
      expect(motionEnabledFromEnvironment()).toBe(true);
    }
    delete process.env.SWEEP_REDUCED_MOTION;
    expect(motionEnabledFromEnvironment()).toBe(true);
  });

  test("pause releases the activity interval, resume owns one, unmount releases it", async () => {
    const intervals = spyOn(globalThis, "setInterval");
    const cleared = spyOn(globalThis, "clearInterval");
    let toggle!: () => void;
    function Probe() {
      const frame = useDotFrame();
      return <text content={`work active · frame ${frame}`} />;
    }
    function Harness() {
      const [enabled, setEnabled] = useState(false);
      toggle = () => setEnabled((value) => !value);
      return (
        <MotionContext.Provider value={enabled}>
          <Probe />
        </MotionContext.Provider>
      );
    }
    let setup: Awaited<ReturnType<typeof testRender>> | undefined;
    try {
      setup = await testRender(<Harness />, { width: 40, height: 6 });
      const activity = () => intervals.mock.calls.filter((call) => call[1] === 160).length;
      expect(activity()).toBe(0);
      await act(async () => toggle());
      expect(activity()).toBe(1);
      const id = intervals.mock.results.find(
        (result, i) => intervals.mock.calls[i]?.[1] === 160,
      )?.value;
      await act(async () => toggle());
      expect(cleared.mock.calls.some((call) => call[0] === id)).toBe(true);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("work active · frame 0");
      await act(async () => toggle());
      expect(activity()).toBe(2);
      const latest = intervals.mock.results
        .filter((_result, i) => intervals.mock.calls[i]?.[1] === 160)
        .at(-1)?.value;
      await act(async () => setup!.renderer.destroy());
      expect(cleared.mock.calls.some((call) => call[0] === latest)).toBe(true);
      setup = undefined;
    } finally {
      if (setup) await act(async () => setup!.renderer.destroy());
      intervals.mockRestore();
      cleared.mockRestore();
    }
  });

  test("paused loaders ignore externally supplied animation frames", async () => {
    const setup = await testRender(
      <MotionContext.Provider value={false}>
        <DotStrip tokens={darkTheme} frame={0} />
        <DotStrip tokens={darkTheme} frame={12} />
      </MotionContext.Provider>,
      { width: 20, height: 5 },
    );
    try {
      await setup.renderOnce();
      const frame = setup.captureSpans();
      expect(frame.lines[0]).toEqual(frame.lines[1]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
