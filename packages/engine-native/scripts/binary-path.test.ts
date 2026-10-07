import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nativePlatformById } from "@kitsunekode/sweep-core/native-platforms";
import { defaultBinaryPath } from "./binary-path.js";

test("foreign packages require their target build; debug binaries are never pack defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-native-path-"));
  const host = { os: "linux", cpu: "x64" };
  const native = nativePlatformById("linux-64")!;
  const foreign = nativePlatformById("linux-arm64")!;
  const put = (path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture");
  };
  try {
    put(join(root, "target/debug/sweep-engine"));
    expect(() => defaultBinaryPath(root, native, host)).toThrow("no release binary");
    const nativePath = join(root, "target/release/sweep-engine");
    put(nativePath);
    expect(defaultBinaryPath(root, native, host)).toBe(nativePath);
    expect(() => defaultBinaryPath(root, foreign, host)).toThrow(foreign.cargoTarget);
    const cross = join(root, "target", foreign.cargoTarget, "release/sweep-engine");
    put(cross);
    expect(defaultBinaryPath(root, foreign, host)).toBe(cross);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
