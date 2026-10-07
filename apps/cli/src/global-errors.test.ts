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
    setActiveApply(undefined);
    handleStdoutError(Object.assign(new Error("report pipe closed"), { code: "EPIPE" }), (code) =>
      exits.push(code),
    );
    expect(exits).toEqual([4]);
  } finally {
    setActiveApply(undefined);
  }
});

test("human read-only pipes retain clean head/early-consumer behavior", async () => {
  // Apply receipt ownership intentionally lasts for the process lifetime.
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {handleStdoutError} from ${JSON.stringify(import.meta.dir + "/global-errors.ts")}; handleStdoutError(Object.assign(new Error("closed"), {code:"EPIPE"})); process.exit(9);`,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  expect(await proc.exited).toBe(0);
});
