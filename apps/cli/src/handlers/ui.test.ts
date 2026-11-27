import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBunExecutable } from "./ui.js";

describe("resolveBunExecutable", () => {
  test("never selects or runs a planted bun binary in cwd via empty or relative PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-ui-bun-cwd-"));
    const relDir = join(root, "relbin");
    mkdirSync(relDir, { recursive: true });
    const marker = join(root, "bun-ran.marker");
    const ext = process.platform === "win32" ? ".exe" : "";
    const cwdPlanted = join(root, `bun${ext}`);
    const relPlanted = join(relDir, `bun${ext}`);
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;

    try {
      if (process.platform === "win32") {
        copyFileSync(process.execPath, cwdPlanted);
        copyFileSync(process.execPath, relPlanted);
      } else {
        const script = `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\nexit 0\n`;
        writeFileSync(cwdPlanted, script);
        writeFileSync(relPlanted, script);
        chmodSync(cwdPlanted, 0o755);
        chmodSync(relPlanted, 0o755);
      }

      const badPaths =
        process.platform === "win32"
          ? [
              "",
              ";C:\\nonexistent-bun-dir",
              "C:\\nonexistent-bun-dir;",
              "C:\\nonexistent-bun-dir;;C:\\also-missing",
              " ",
              ".",
              ".\\relbin",
              "relbin",
            ]
          : [
              "",
              ":/nonexistent-bun-dir",
              "/nonexistent-bun-dir:",
              "/nonexistent-bun-dir::/also-missing",
              " ",
              ".",
              "./relbin",
              "relbin",
            ];

      process.chdir(root);
      for (const pathEnv of badPaths) {
        process.env.PATH = pathEnv;
        expect(resolveBunExecutable()).toBeUndefined();
        expect(existsSync(marker)).toBe(false);
      }
    } finally {
      process.chdir(previousCwd);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
