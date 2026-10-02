import { expect, test } from "bun:test";
import { mapPool } from "./async-pool.js";

test("pool stops claiming jobs and drains admitted work before rejecting", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: number[] = [];
  let settled = false;
  let drained = false;
  const result = mapPool([0, 1, 2, 3], 2, async (item) => {
    started.push(item);
    if (item === 0) throw new Error("injected failure");
    await held;
    drained = true;
  }).catch((error) => {
    settled = true;
    return error;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(started).toEqual([0, 1]);
  release();
  expect((await result).message).toBe("injected failure");
  expect(drained).toBe(true);
});
