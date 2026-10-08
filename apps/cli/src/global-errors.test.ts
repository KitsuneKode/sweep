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

for (const trigger of ["throw", "reject"] as const) {
  test(`${trigger} crash honors JSON mode and reports unknown mutation`, async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import {installGlobalErrorHandlers} from ${JSON.stringify(import.meta.dir + "/global-errors.ts")};
      import {makeProgram} from ${JSON.stringify(import.meta.dir + "/cli.ts")};
      import {noteApplyBackendEntered} from ${JSON.stringify(import.meta.dir + "/apply-lifecycle.ts")};
      installGlobalErrorHandlers();
      const program = makeProgram();
      program.command("crash-probe").option("--json").action(() => {
        noteApplyBackendEntered();
        ${trigger === "throw" ? 'queueMicrotask(() => {throw new Error("crash\\u001b[31m")});' : 'Promise.reject(new Error("crash\\u001b[31m"));'}
      });
      program.parse(["runtime", "sweep", "crash-probe", "--json"]);
      setTimeout(() => process.exit(9), 1000);
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(4);
    expect(stdout).toBe("");
    const error = JSON.parse(stderr.trim());
    expect(error).toMatchObject({
      type: "error",
      exitCode: 4,
      applyOutcome: "unknown",
      retryable: false,
    });
    expect(error.message).not.toContain("\u001b");
  });
}
