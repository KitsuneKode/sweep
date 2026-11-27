import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleInit, type InitHandlerOptions } from "./init.js";

function initOpts(overrides: Partial<InitHandlerOptions> = {}): InitHandlerOptions {
  return {
    dryRun: false,
    yes: true,
    force: false,
    forceLarge: false,
    pattern: [],
    disabledPattern: [],
    ignore: [],
    includeDangerous: false,
    select: "default",
    color: false,
    engine: "js",
    ...overrides,
  };
}

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sweep-init-handler-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("handleInit refusal messages", () => {
  test.skipIf(process.platform === "win32")(
    "refuses an existing .sweeprc owned by another user without suggesting --force",
    async () => {
      const project = join(tmpDir, "other-owner");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, ".sweeprc"), "{}\n");

      const errors: string[] = [];
      const errSpy = spyOn(console, "error").mockImplementation((...args) => {
        errors.push(args.map(String).join(" "));
      });
      const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new ExitSentinel(code ?? 0);
      }) as typeof process.exit);
      const uidSpy = spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);

      try {
        await expect(handleInit(initOpts({ path: project, force: false }))).rejects.toThrow(
          ExitSentinel,
        );
        expect(exitSpy).toHaveBeenCalledWith(3);
        const output = errors.join("\n");
        expect(output).toContain("owned by another user");
        expect(output).toContain("cannot be replaced by sweep");
        expect(output).not.toContain("--force");
      } finally {
        uidSpy.mockRestore();
        exitSpy.mockRestore();
        errSpy.mockRestore();
      }
    },
  );

  test("refuses a non-regular .sweeprc without suggesting --force", async () => {
    const project = join(tmpDir, "dir-sweeprc");
    mkdirSync(join(project, ".sweeprc"), { recursive: true });

    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.map(String).join(" "));
    });
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSentinel(code ?? 0);
    }) as typeof process.exit);

    try {
      await expect(handleInit(initOpts({ path: project, force: false }))).rejects.toThrow(
        ExitSentinel,
      );
      expect(exitSpy).toHaveBeenCalledWith(3);
      const output = errors.join("\n");
      expect(output).toContain("not a regular file");
      expect(output).toContain("cannot be replaced by sweep");
      expect(output).not.toContain("--force");
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
