import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  engineTrustIssue,
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

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

test("the spawned process must still be the verified engine", () => {
  const engine = join(root, exe("engine"));
  copyFileSync(nativeSample(), engine);
  chmodSync(engine, 0o700);
  const identity = captureEngineIdentity(engine);
  const child = spawnCopy(engine);
  try {
    expect(() => assertSpawnedEngine(child.pid!, identity)).not.toThrow();
  } finally {
    child.kill("SIGKILL");
  }
});

test("a swap between verification and spawn is caught right after the spawn", () => {
  // Every platform: the path re-check after spawn sees that the file the
  // child was started from is not the verified one.
  const engine = join(root, exe("engine"));
  const other = join(root, exe("other"));
  copyFileSync(nativeSample(), engine);
  copyFileSync(nativeSample(), other);
  chmodSync(engine, 0o700);
  chmodSync(other, 0o700);
  const identity = captureEngineIdentity(engine);
  renameSync(other, engine);
  const child = spawnCopy(engine);
  try {
    expect(identityIssue(() => assertSpawnedEngine(child.pid!, identity))).toBe("changed");
  } finally {
    child.kill("SIGKILL");
  }
});

test.skipIf(process.platform === "win32")(
  "posix: a swap while the engine runs is caught after the spawn",
  () => {
    // Windows refuses to replace a running image, so this case cannot occur there.
    const engine = join(root, "engine");
    const other = join(root, "other");
    copyFileSync(nativeSample(), engine);
    copyFileSync(nativeSample(), other);
    chmodSync(engine, 0o700);
    const identity = captureEngineIdentity(engine);
    const child = spawnCopy(engine);
    try {
      renameSync(other, engine);
      expect(identityIssue(() => assertSpawnedEngine(child.pid!, identity))).toBe("changed");
    } finally {
      child.kill("SIGKILL");
    }
  },
);

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

describe("posix: engine owners", () => {
  const USER = 1001;
  const OTHER = 1002;
  const enginePath = "/home/user/.local/sweep/sweep-engine";
  /** Every path on the way to the engine is owned by `owner`, except root-owned `/` and `/home`. */
  const tree =
    (owner: number, overrides: Record<string, { uid?: number; mode?: number }> = {}) =>
    (path: string) => {
      const base =
        path === "/" || path === "/home"
          ? { uid: 0, gid: 0, mode: 0o40755 }
          : { uid: owner, gid: owner, mode: path === enginePath ? 0o100755 : 0o40755 };
      return { ...base, ...overrides[path] };
    };
  const asRoot = (sudoUid?: string) => ({ uid: 0, gid: 0, sudoUid });

  test.skipIf(process.platform === "win32")(
    "root accepts an engine owned by the user sudo acts for",
    () => {
      expect(engineTrustIssue(enginePath, asRoot(String(USER)), tree(USER))).toBeNull();
    },
  );

  test.skipIf(process.platform === "win32")(
    "root refuses an engine owned by a user other than SUDO_UID",
    () => {
      expect(engineTrustIssue(enginePath, asRoot(String(OTHER)), tree(USER))).toContain(
        `owned by another user (uid ${USER})`,
      );
      // One foreign directory on the way is enough to refuse.
      expect(
        engineTrustIssue(
          enginePath,
          asRoot(String(USER)),
          tree(USER, { "/home/user/.local": { uid: OTHER } }),
        ),
      ).toContain("/home/user/.local is owned by another user");
    },
  );

  test.skipIf(process.platform === "win32")(
    "root without a usable SUDO_UID refuses a user-owned engine",
    () => {
      for (const sudoUid of [undefined, "", "abc", "-1", "1001x", " 1001", "99999999999"]) {
        expect(engineTrustIssue(enginePath, asRoot(sudoUid), tree(USER))).toContain(
          "owned by another user",
        );
      }
      expect(engineTrustIssue(enginePath, asRoot(), tree(0))).toBeNull();
    },
  );

  test.skipIf(process.platform === "win32")(
    "under sudo, writable files and directories stay refused",
    () => {
      const sudo = asRoot(String(USER));
      expect(
        engineTrustIssue(enginePath, sudo, tree(USER, { [enginePath]: { mode: 0o100777 } })),
      ).toContain("world-writable");
      expect(
        engineTrustIssue(enginePath, sudo, tree(USER, { "/home/user": { mode: 0o40775 } })),
      ).toContain("group-writable");
      expect(
        engineTrustIssue(enginePath, sudo, tree(USER, { "/home/user": { mode: 0o41777 } })),
      ).toBeNull();
    },
  );

  test.skipIf(process.platform === "win32")("SUDO_UID means nothing to a non-root user", () => {
    const asUser = { uid: USER, gid: USER, sudoUid: String(OTHER) };
    expect(engineTrustIssue(enginePath, asUser, tree(USER))).toBeNull();
    expect(engineTrustIssue(enginePath, asUser, tree(0))).toBeNull();
    expect(engineTrustIssue(enginePath, asUser, tree(OTHER))).toContain("owned by another user");
  });
});

test.skipIf(process.platform === "win32")("an untrusted-engine refusal says how to proceed", () => {
  const shared = join(root, "shared");
  mkdirSync(shared);
  const engine = join(shared, "engine");
  writeFileSync(engine, "#!/bin/sh\nexit 0\n");
  chmodSync(shared, 0o777);
  try {
    inspectEngineFile(engine);
    throw new Error("expected a refusal");
  } catch (error) {
    expect((error as Error).message).toContain("Use --engine js, or reinstall the engine");
    expect((error as Error).message).not.toMatch(/disable|skip|--no-/i);
  }
});
