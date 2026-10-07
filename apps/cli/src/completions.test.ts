import { describe, expect, test } from "bun:test";
import { makeProgram } from "@kitsunekode/sweep";
import { renderCompletions } from "./handlers/completions.js";

// Completion scripts are generated from the live Commander program, so drift
// would mean a generator bug - not a stale list. These tests pin both: every
// command and every long flag must appear in every shell's output.
describe("generated completions", () => {
  const program = makeProgram();
  const shells = ["bash", "zsh", "fish"];

  test("every command is completable in every shell", () => {
    for (const shell of shells) {
      const script = renderCompletions(shell, program);
      expect(script).toBeDefined();
      for (const command of program.commands) {
        expect(script).toContain(command.name());
      }
    }
  });

  test("every long flag appears in every shell's script", () => {
    const allFlags = new Set<string>();
    for (const option of program.options) {
      if (option.long) allFlags.add(option.long);
    }
    for (const command of program.commands) {
      for (const option of command.options) {
        if (option.long) allFlags.add(option.long);
      }
    }

    for (const shell of shells) {
      const script = renderCompletions(shell, program)!;
      for (const flag of allFlags) {
        // fish writes flags as `-l dry-run`; bash/zsh write `--dry-run`.
        expect(script).toContain(flag.slice(2));
      }
    }
  });

  test("unknown shells render nothing", () => {
    expect(renderCompletions("powershell", program)).toBeUndefined();
  });

  test("zsh completes option values instead of treating them as directories", () => {
    const script = renderCompletions("zsh", program)!;
    expect(script).toContain("--plan[sweep option]:file:_files");
    expect(script).toContain("--journal[sweep option]:file:_files");
    expect(script).toContain("--engine[sweep option]:value:(auto js rust)");
    expect(script).toContain("--depth[sweep option]:number:");
  });
});
