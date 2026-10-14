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
