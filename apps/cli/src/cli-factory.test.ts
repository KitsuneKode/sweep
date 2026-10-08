import { describe, expect, test } from "bun:test";
import { makeProgram } from "@kitsunekode/sweep";

describe("CLI factory", () => {
  test("machine-oriented usage errors provide a structured non-retryable receipt", async () => {
    const proc = Bun.spawn(
      [process.execPath, import.meta.dir + "/bin.ts", "--json", "scan", "--depth", "bad"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      type: "error",
      code: "invalid_arguments",
      exitCode: 2,
      retryable: false,
    });
  });
  test("per-run byte ceilings preserve explicit none, zero, and numeric limits", () => {
    for (const [text, value] of [
      ["none", "none"],
      ["0", 0],
      ["600.5", 600.5],
    ] as const) {
      const program = makeProgram().exitOverride();
      program.parseOptions(["--max-size-gb", text]);
      expect(program.opts().maxSizeGb).toBe(value);
    }
    for (const text of ["NaN", "Infinity", "-1", "600GB", "99999999999"]) {
      const program = makeProgram().exitOverride();
      expect(() => program.parseOptions(["--max-size-gb", text])).toThrow();
    }
  });
  test("usage errors are not cancellation and escape untrusted arguments", async () => {
    const proc = Bun.spawn(
      [process.execPath, import.meta.dir + "/bin.ts", "scan", "--depth", "\x1b]0;forged\x07"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("\x1b");
    expect(stderr).not.toContain("\x07");
    expect(stderr).toContain("expected an integer");
  });
  test("resource profiles accept only the supported names", () => {
    const program = makeProgram().exitOverride();
    program.parseOptions(["--resource-profile", "low-memory"]);
    expect(program.opts().resourceProfile).toBe("low-memory");
    expect(() => program.parseOptions(["--resource-profile", "unlimited"])).toThrow();
  });
  test("makeProgram() parses --help without side effects", () => {
    const program = makeProgram();
    program.exitOverride();

    let helpText = "";
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      helpText += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;

    try {
      program.parse(["node", "sweep", "--help"], { from: "node" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/help|outputHelp/i);
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(helpText).toContain("Safe, fast artifact cleanup");
    expect(helpText).toContain("scan");
    expect(helpText).toContain("apply");
    expect(helpText).toContain("ui");
  });
});

test("the UI never claims its honored byte ceiling is ignored", async () => {
  const proc = Bun.spawn(
    [process.execPath, import.meta.dir + "/bin.ts", "ui", ".", "--max-size-gb", "600"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toContain("requires an interactive TTY");
  expect(stderr).not.toContain("--max-size-gb has no effect");
});
