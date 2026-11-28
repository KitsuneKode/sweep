import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertEngineUnchanged,
  assertSpawnedEngine,
  captureEngineIdentity,
  EngineIdentityError,
  inspectEngineFile,
  resetEngineIdentityCacheForTest,
} from "./engine-identity.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sweep-engine-identity-")));
  resetEngineIdentityCacheForTest();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function identityIssue(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(EngineIdentityError);
    return (error as EngineIdentityError).issue;
  }
}

/** A small native executable to copy, per platform. */
function nativeSample(): string {
  if (process.platform === "win32") {
    return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe");
  }
  return realpathSync("/bin/sleep");
}

test("identity pins the resolved file, its contents and its kind", () => {
  const engine = join(root, "engine");
  writeFileSync(engine, "#!/bin/sh\nexit 0\n");
  const identity = captureEngineIdentity(engine);
  expect(identity.path).toBe(realpathSync(engine));
  expect(identity.sha256).toBe(createHash("sha256").update(readFileSync(engine)).digest("hex"));
  expect(identity.nativeImage).toBe(false);
  expect(captureEngineIdentity(nativeSample()).nativeImage).toBe(true);
  expect(() => assertEngineUnchanged(identity)).not.toThrow();
});

test("a file renamed over the engine path is a different engine", () => {
  const engine = join(root, "engine");
  const replacement = join(root, "replacement");
  writeFileSync(engine, "#!/bin/sh\nexit 0\n");
  writeFileSync(replacement, "#!/bin/sh\nexit 0\n");
  const identity = captureEngineIdentity(engine);
  renameSync(replacement, engine);
  expect(identityIssue(() => assertEngineUnchanged(identity))).toBe("changed");
});

test("rewriting the engine in place is a different engine", () => {
  const engine = join(root, "engine");
  writeFileSync(engine, "#!/bin/sh\nexit 0\n");
  const identity = captureEngineIdentity(engine);
  writeFileSync(engine, "#!/bin/sh\nexit 1\n");
  expect(identityIssue(() => assertEngineUnchanged(identity))).toBe("changed");
});

test("a removed engine fails closed", () => {
  const engine = join(root, "engine");
  writeFileSync(engine, "#!/bin/sh\nexit 0\n");
  const identity = captureEngineIdentity(engine);
  rmSync(engine);
  expect(identityIssue(() => assertEngineUnchanged(identity))).toBe("changed");
  expect(identityIssue(() => captureEngineIdentity(engine))).toBe("unreadable");
});

test("a directory is not an engine", () => {
  expect(identityIssue(() => inspectEngineFile(root))).toBe("unreadable");
});

function spawnCopy(path: string) {
  // argv0 keeps multi-call coreutils builds dispatching to `sleep`.
  const child =
    process.platform === "win32"
      ? spawn(path, [], { stdio: "ignore" })
      : spawn(path, ["5"], { stdio: "ignore", argv0: "sleep" });
  child.on("error", () => {});
  return child;
}

test("the spawned process must still be the verified engine", async () => {
  const engine = join(root, process.platform === "win32" ? "engine.exe" : "engine");
  copyFileSync(nativeSample(), engine);
  chmodSync(engine, 0o700);
  const identity = captureEngineIdentity(engine);
  const child = spawnCopy(engine);
  try {
    expect(() => assertSpawnedEngine(child.pid!, identity)).not.toThrow();
  } finally {
    child.kill("SIGKILL");
  }
  // The path no longer names the verified file once the spawn returns.
  const other = join(root, process.platform === "win32" ? "other.exe" : "other");
  copyFileSync(nativeSample(), other);
  const late = spawnCopy(engine);
  try {
    renameSync(other, engine);
    expect(identityIssue(() => assertSpawnedEngine(late.pid!, identity))).toBe("changed");
  } finally {
    late.kill("SIGKILL");
  }
});

test.skipIf(process.platform !== "linux")(
  "linux: a swap reverted around the spawn is caught from the process image",
  () => {
    const engine = join(root, "engine");
    const impostor = join(root, "impostor");
    copyFileSync(nativeSample(), engine);
    // Same bytes, different file: identical content alone must not pass.
    copyFileSync(nativeSample(), impostor);
    chmodSync(engine, 0o700);
    chmodSync(impostor, 0o700);
    const identity = captureEngineIdentity(engine);
    const child = spawnCopy(impostor);
    try {
      expect(identityIssue(() => assertSpawnedEngine(child.pid!, identity))).toBe("changed");
    } finally {
      child.kill("SIGKILL");
    }
  },
);

test.skipIf(process.platform === "win32")("posix: engines others can replace are refused", () => {
  const shared = join(root, "shared");
  mkdirSync(shared);
  const engine = join(shared, "engine");
  writeFileSync(engine, "#!/bin/sh\nexit 0\n");
  chmodSync(engine, 0o700);
  expect(identityIssue(() => inspectEngineFile(engine))).toBeUndefined();

  chmodSync(shared, 0o777);
  expect(identityIssue(() => inspectEngineFile(engine))).toBe("untrusted");
  expect(identityIssue(() => captureEngineIdentity(engine))).toBe("untrusted");

  // Sticky directories (like /tmp) only let others replace their own entries.
  chmodSync(shared, 0o1777);
  expect(identityIssue(() => inspectEngineFile(engine))).toBeUndefined();

  chmodSync(shared, 0o700);
  chmodSync(engine, 0o777);
  expect(identityIssue(() => inspectEngineFile(engine))).toBe("untrusted");
});

test.skipIf(process.platform === "win32")(
  "posix: trust becoming worse after verification fails the re-check",
  () => {
    const shared = join(root, "shared");
    mkdirSync(shared);
    const engine = join(shared, "engine");
    writeFileSync(engine, "#!/bin/sh\nexit 0\n");
    chmodSync(engine, 0o700);
    const identity = captureEngineIdentity(engine);
    chmodSync(shared, 0o777);
    expect(identityIssue(() => assertEngineUnchanged(identity))).toBe("untrusted");
  },
);
