import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineIdentityError } from "./engine-identity.js";

/**
 * The packaged CLI and terminal UI each bundle their own copy of
 * rust-engine.ts and run in one process. Two module instances stand in for
 * the two bundles here (a query string makes Bun load a separate instance).
 * The built bundles are covered by scripts/smoke-engine-binding-ui.py.
 */
type RustEngineModule = typeof import("./rust-engine.js");
const loadCopy = async (bundle: string) =>
  (await import(`${join(import.meta.dir, "rust-engine.ts")}?bundle=${bundle}`)) as RustEngineModule;
const cliCopy = await loadCopy("cli");
const uiCopy = await loadCopy("ui");
// Without two instances these tests would prove nothing; they then skip, and
// the instance test below fails on the platforms where Bun separates them.
const separate = cliCopy.acquireRustEngine !== uiCopy.acquireRustEngine;

let root: string;
const previous = {
  engine: process.env.SWEEP_ENGINE_PATH,
  scripts: process.env.SWEEP_ALLOW_SCRIPT_ENGINE,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sweep-shared-binding-"));
  process.env.SWEEP_ENGINE_PATH = join(root, "engine");
  // The fake engines are scripts; nothing here spawns them.
  process.env.SWEEP_ALLOW_SCRIPT_ENGINE = "1";
  writeFileSync(join(root, "engine"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(root, "replacement"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
});

afterEach(() => {
  cliCopy.resetRustEngineBindingsForTest();
  for (const [key, value] of [
    ["SWEEP_ENGINE_PATH", previous.engine],
    ["SWEEP_ALLOW_SCRIPT_ENGINE", previous.scripts],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function issueOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(EngineIdentityError);
    return (error as EngineIdentityError).issue;
  }
}

test.skipIf(process.platform === "win32")("separate module copies are separate instances", () => {
  expect(separate).toBe(true);
});

for (const [binder, user] of [
  ["ui", "cli"],
  ["cli", "ui"],
] as const) {
  test.skipIf(!separate)(
    `an engine bound by the ${binder} copy is the only engine the ${user} copy runs`,
    () => {
      const bind = binder === "ui" ? uiCopy : cliCopy;
      const use = user === "ui" ? uiCopy : cliCopy;
      bind.acquireRustEngine();
      // The other copy's first use comes after the swap: with its own registry
      // it would bind the new file; sharing the binding, it must refuse.
      renameSync(join(root, "replacement"), join(root, "engine"));
      expect(issueOf(() => use.acquireRustEngine())).toBe("changed");
      expect(issueOf(() => bind.acquireRustEngine())).toBe("changed");
    },
  );
}

test.skipIf(!separate)("the reset is shared too", () => {
  uiCopy.acquireRustEngine();
  cliCopy.resetRustEngineBindingsForTest();
  renameSync(join(root, "replacement"), join(root, "engine"));
  // After a shared reset, the next use binds the new file in both copies.
  const rebound = cliCopy.acquireRustEngine().identity;
  expect(uiCopy.acquireRustEngine().identity.sha256).toBe(rebound.sha256);
});

test.skipIf(!separate)(
  "the shared state cannot be replaced, and a malformed binding fails closed",
  () => {
    cliCopy.acquireRustEngine();
    const key = Symbol.for("@kitsunekode/sweep.engineBinding.v1");
    const holder = globalThis as unknown as Record<symbol, unknown>;
    const state = holder[key] as { bindings: Map<string, unknown> };
    expect(() => {
      holder[key] = { version: 1, bindings: new Map() };
    }).toThrow();
    expect(holder[key]).toBe(state);
    expect(Object.isSealed(state)).toBe(true);
    for (const bindingKey of state.bindings.keys())
      state.bindings.set(bindingKey, { file: process.env.SWEEP_ENGINE_PATH, identity: {} });
    expect(issueOf(() => uiCopy.acquireRustEngine())).toBe("unreadable");
  },
);
