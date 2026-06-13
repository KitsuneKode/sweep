import { describe, expect, test } from "bun:test";
import { makeProgram } from "@kitsunekode/sweep-cli";

describe("CLI factory", () => {
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
