import { expect, test } from "bun:test";
import { setActiveApply } from "./apply-lifecycle.js";
import { handleStdoutError } from "./global-errors.js";

test("a broken sink cancels active apply and lets its outcome/history finish", () => {
  const controller = new AbortController();
  setActiveApply(controller);
  const exits: number[] = [];
  try {
    handleStdoutError(Object.assign(new Error("pipe closed"), { code: "EPIPE" }), (code) =>
      exits.push(code),
    );
    expect(controller.signal.aborted).toBe(true);
    expect(exits).toEqual([]);
  } finally {
    setActiveApply(undefined);
  }
});

test("human read-only pipes retain clean head/early-consumer behavior", () => {
  const exits: number[] = [];
  handleStdoutError(Object.assign(new Error("pipe closed"), { code: "EPIPE" }), (code) =>
    exits.push(code),
  );
  expect(exits).toEqual([0]);
});
