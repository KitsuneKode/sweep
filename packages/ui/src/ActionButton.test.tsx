import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ActionButton } from "./ActionButton.js";
import { darkTheme } from "./theme.js";

let destroy: (() => void) | undefined;
afterEach(async () => {
  await act(async () => destroy?.());
  destroy = undefined;
});

test("buttons activate on left release, never on press, right/middle click, drag or outside release", async () => {
  let first = 0;
  let second = 0;
  const setup = await testRender(
    <box flexDirection="row">
      <ActionButton tokens={darkTheme} label="First" onPress={() => first++} />
      <ActionButton tokens={darkTheme} label="Second" onPress={() => second++} />
    </box>,
    { width: 30, height: 4 },
  );
  destroy = () => setup.renderer.destroy();
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
  });
  const send = async (action: () => Promise<void>) =>
    act(async () => {
      await action();
      await setup.flush();
    });
  await send(() => setup.mockMouse.pressDown(2, 0));
  expect(first).toBe(0);
  await send(() => setup.mockMouse.release(2, 0));
  expect(first).toBe(1);
  await send(() => setup.mockMouse.click(2, 0, 2));
  await send(() => setup.mockMouse.click(2, 0, 1));
  await send(() => setup.mockMouse.drag(2, 0, 3, 0));
  await send(() => setup.mockMouse.pressDown(2, 0));
  await send(() => setup.mockMouse.release(10, 0));
  expect(first).toBe(1);
  expect(second).toBe(0);
  await send(() => setup.mockMouse.click(10, 0));
  expect(second).toBe(1);
});

test("disabled buttons never dispatch", async () => {
  let count = 0;
  const setup = await testRender(
    <ActionButton tokens={darkTheme} label="Disabled" disabled onPress={() => count++} />,
    { width: 20, height: 4 },
  );
  destroy = () => setup.renderer.destroy();
  await act(async () => {
    await setup.renderOnce();
    await setup.flush();
    await setup.mockMouse.click(2, 0);
    await setup.flush();
  });
  expect(count).toBe(0);
});

test("primary leads only while enabled, so a dead action is never advertised", async () => {
  const frameOf = async (node: React.ReactNode) => {
    const setup = await testRender(node, { width: 24, height: 2 });
    try {
      await act(async () => {
        await setup.renderOnce();
      });
      return JSON.stringify(setup.captureSpans().lines[0]);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  };
  const label = "Review queue (5)";
  const plain = await frameOf(<ActionButton tokens={darkTheme} label={label} onPress={() => {}} />);
  const lead = await frameOf(
    <ActionButton tokens={darkTheme} label={label} primary onPress={() => {}} />,
  );
  expect(lead).not.toBe(plain);

  const disabledPlain = await frameOf(
    <ActionButton tokens={darkTheme} label={label} disabled onPress={() => {}} />,
  );
  const disabledPrimary = await frameOf(
    <ActionButton tokens={darkTheme} label={label} primary disabled onPress={() => {}} />,
  );
  expect(disabledPrimary).toBe(disabledPlain);
});
