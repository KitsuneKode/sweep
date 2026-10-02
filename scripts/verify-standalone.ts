#!/usr/bin/env bun
/**
 * Release-tier verify step: compile a standalone `sweep` binary into a temp
 * dir and run the standalone smoke against it. Requires the release Rust
 * engine (the binary embeds it) - the caller's `unless` guard skips when
 * absent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "sweep-verify-standalone-"));
const bin = join(dir, process.platform === "win32" ? "sweep.exe" : "sweep");
try {
  for (const args of [
    ["bun", "run", "scripts/build-standalone.ts", "", bin],
    ["bun", "run", "scripts/smoke-standalone.ts", bin],
  ]) {
    const proc = Bun.spawn(args, {
      cwd: REPO_ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) process.exit(code);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
