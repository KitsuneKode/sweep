import { SCAN_RESOURCE_PROFILES } from "@kitsunekode/sweep-protocol";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ApplyReport,
  ScanPlan,
  SelectionPolicy,
  SweepConfig,
} from "@kitsunekode/sweep-protocol";
import { DEFAULT_SELECTION_POLICY } from "@kitsunekode/sweep-protocol";
import { isColdRequested } from "./cold.js";
import {
  assertEngineContent,
  assertSpawnedEngine,
  captureEngineIdentity,
  EngineIdentityError,
  inspectEngineFile,
  sameEngineFile,
  type EngineIdentity,
} from "./engine-identity.js";
import {
  isExplicitBinaryPath,
  lookupExecutable,
  windowsShellFreeExtensions,
  type PathLookupOptions,
  type PathLookupResult,
} from "./executable-lookup.js";
import { ApplyOutcomeUnknownError, ApplyRefusedError, GuardrailError } from "./guardrails.js";
import { applyPlanInsights, buildPlan } from "./planner.js";
import {
  PlanValidationError,
  validateApplyReport,
  validatePlan,
  warmPlanValidator,
} from "./plan.js";
import type { ScanHooks } from "./scanner.js";
import type { ScanToPlanOptions } from "./engine.js";
import { nativePlatformForCurrentProcess } from "./native-platforms.js";
import { NdjsonDecoder } from "./ndjson.js";
import { RustScanStream } from "./rust-stream.js";

export type EngineBackend = "js" | "rust";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

let embeddedEngine: (() => string) | undefined;

/** Standalone entrypoint supplies a lazy, private native asset extraction. */
export function registerEmbeddedEngine(resolver: () => string): void {
  embeddedEngine = resolver;
}

/**
 * Root of the published `@kitsunekode/sweep` npm package (`apps/cli`), or the monorepo in dev.
 *
 * - Bundled CLI (`apps/cli/dist/sweep.js`): parent of `dist/`
 * - Dev (`packages/core/src/...`): walk up to `package.json` named `@kitsunekode/sweep`
 */
export function sweepPackageRoot(fromModuleDir: string = MODULE_DIR): string {
  const normalized = fromModuleDir.replace(/\\/g, "/");

  // `dist` must be the TRAILING component - substring matching mis-slices a
  // path that merely contains it (`/work/dist-app/...` -> `/work`, or a repo
  // nested under a literal `dist` dir), pointing engine resolution at a
  // foreign tree. Deeper module dirs fall through to the package.json walk.
  const parts = normalized.split("/");
  if (parts[parts.length - 1] === "dist") {
    return resolve(parts.slice(0, -1).join("/"));
  }

  let dir = fromModuleDir;
  for (let depth = 0; depth < 8; depth++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (parsed.name === "@kitsunekode/sweep") {
          return resolve(dir);
        }
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return resolve(fromModuleDir, "../../..");
}

function resolveOptionalNativeBinary(packageRoot: string): string | null {
  const platform = nativePlatformForCurrentProcess();
  if (!platform) {
    return null;
  }

  try {
    const require = createRequire(join(packageRoot, "package.json"));
    return require.resolve(`${platform.npmName}/bin/${platform.binaryName}`);
  } catch {
    return null;
  }
}

/**
 * Is `dir` a checkout of this repository? The dev-engine shadow is only
 * honored for our own workspace shape - crates/sweep-engine plus an
 * apps/cli package.json named @kitsunekode/sweep.
 */
function isSweepWorkspaceRoot(dir: string): boolean {
  if (!existsSync(join(dir, "Cargo.toml")) || !existsSync(join(dir, "crates", "sweep-engine"))) {
    return false;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "apps", "cli", "package.json"), "utf8")) as {
      name?: string;
    };
    return pkg.name === "@kitsunekode/sweep";
  } catch {
    return false;
  }
}

/**
 * Resolve the `sweep-engine` binary used for Rust backend subprocess calls.
 *
 * Resolution order:
 * 1. `SWEEP_ENGINE_PATH` environment variable
 * 2. Workspace `target/{debug,release}/sweep-engine` (dev builds must shadow
 *    the installed optional package - otherwise local Rust changes are never
 *    exercised by tests or dev runs while `cargo test` validates other code)
 * 3. Installed optional `@kitsunekode/sweep-engine-*` platform package
 * 4. `sweep-engine` on `PATH` (absolute directories only)
 */
export function resolveRustEngineBinary(): string {
  const fromEnv = process.env.SWEEP_ENGINE_PATH;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  if (embeddedEngine) {
    try {
      return embeddedEngine();
    } catch {
      // A full/missing extraction directory does not invalidate an installed
      // engine. Continue the documented resolution chain before falling back.
    }
  }

  const packageRoot = sweepPackageRoot();
  const binaryName = process.platform === "win32" ? "sweep-engine.exe" : "sweep-engine";

  // Cargo workspace builds land in <repo>/target, not <repo>/apps/cli/target -
  // walk up so a local build is found from either layout. The gate must prove
  // this is a checkout of THIS repository: a foreign repo that commits a
  // Cargo.toml plus an executable target/debug/sweep-engine would otherwise
  // have sweep auto-execute its binary on any invocation (a planted binary
  // is arbitrary code execution triggered by merely running `sweep` inside
  // that project). Require the sweep workspace shape - crates/sweep-engine
  // plus apps/cli/package.json naming @kitsunekode/sweep.
  // Newest build wins - a stale target/release artifact must not beat a fresh
  // cargo build --profile dev.
  for (let dir = packageRoot, depth = 0; depth < 4; depth++) {
    if (isSweepWorkspaceRoot(dir)) {
      let newest: { path: string; mtimeMs: number } | null = null;
      for (const profile of ["debug", "release"] as const) {
        const local = join(dir, "target", profile, binaryName);
        try {
          const { mtimeMs } = statSync(local);
          if (!newest || mtimeMs > newest.mtimeMs) {
            newest = { path: local, mtimeMs };
          }
        } catch {
          // not built for this profile
        }
      }
      if (newest) {
        return newest.path;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  const fromOptional = resolveOptionalNativeBinary(packageRoot);
  if (fromOptional) {
    return fromOptional;
  }

  return resolveExecutableOnPath("sweep-engine") ?? "sweep-engine";
}

export {
  lookupExecutable,
  windowsShellFreeExtensions,
  type PathLookupOptions,
  type PathLookupResult,
};

function resolveExecutableOnPath(binary: string): string | undefined {
  return lookupExecutable(binary).resolvedPath;
}

export interface ResolvedRustEngineExecutable {
  binary: string;
  executable?: string;
  explicitConfigured: boolean;
}

export function resolveRustEngineExecutable(): ResolvedRustEngineExecutable {
  const explicitConfigured = Boolean(process.env.SWEEP_ENGINE_PATH);
  const binary = resolveRustEngineBinary();
  const lookup = lookupExecutable(binary);
  const executable = lookup.resolvedPath ?? lookup.nonExecutablePath;
  return executable ? { binary, executable, explicitConfigured } : { binary, explicitConfigured };
}

function missingRustEngineMessage(binary: string, explicitConfigured: boolean): string {
  return explicitConfigured || isExplicitBinaryPath(binary)
    ? `Configured Rust engine path was not found: ${binary}.`
    : "Native Rust engine binary was not found.";
}

/** No engine file resolved at all (as opposed to one that failed its checks). */
export class RustEngineMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RustEngineMissingError";
  }
}

export interface AcquiredRustEngine {
  /** What resolution produced (for messages). */
  binary: string;
  /** The resolved executable path the binding was made for. */
  file: string;
  /** The bound, verified file. Spawn `identity.path`. */
  identity: EngineIdentity;
}

interface EngineBinding {
  file: string;
  identity: EngineIdentity;
}

/**
 * One engine per operation. The first use of the native engine in this
 * process (the `--engine auto` probe, or the first scan, apply, tracked
 * check, discovery or doctor call under `--engine rust`) binds the file it
 * resolved: real path, metadata and a fresh SHA-256. Every later use, in any
 * of those places and for the rest of the process (a CLI command or a whole
 * terminal UI session), must resolve to that same file, or it is refused.
 * Keyed by the settings that choose an engine, so a test that points
 * SWEEP_ENGINE_PATH somewhere else gets its own binding; a change on disk
 * under the same settings never does.
 */
interface SharedEngineState {
  readonly version: 1;
  readonly bindings: Map<string, EngineBinding>;
  availability: { key: string; result: RustEngineProbeResult } | undefined;
}

/**
 * The packaged CLI (`dist/sweep.js`) and the terminal UI (`dist/sweep-ui.js`)
 * each bundle their own copy of this module and run in one Bun process. A
 * module-level map would give each copy its own binding, so the UI could scan
 * with one file and the CLI apply with another. The state lives on
 * `globalThis` under a registered symbol so every copy in the process shares
 * it. Created once, non-writable and sealed; anything unexpected at the key
 * fails closed rather than being replaced.
 */
const ENGINE_STATE_KEY = Symbol.for("@kitsunekode/sweep.engineBinding.v1");

function isSharedEngineState(value: unknown): value is SharedEngineState {
  if (typeof value !== "object" || value === null || !Object.isSealed(value)) return false;
  const state = value as Partial<SharedEngineState>;
  return state.version === 1 && state.bindings instanceof Map;
}

function sharedEngineState(): SharedEngineState {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  const existing = holder[ENGINE_STATE_KEY];
  if (existing !== undefined) {
    if (!isSharedEngineState(existing))
      throw new EngineIdentityError(
        "The native engine binding for this process is not recognized",
        "unreadable",
      );
    return existing;
  }
  const state: SharedEngineState = Object.seal({
    version: 1 as const,
    bindings: new Map<string, EngineBinding>(),
    availability: undefined,
  });
  Object.defineProperty(globalThis, ENGINE_STATE_KEY, {
    value: state,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return state;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** A binding read from shared state must have exactly the shape this copy writes. */
function validBinding(value: unknown): value is EngineBinding {
  if (typeof value !== "object" || value === null) return false;
  const { file, identity } = value as Partial<EngineBinding>;
  if (typeof file !== "string" || typeof identity !== "object" || identity === null) return false;
  return (
    typeof identity.path === "string" &&
    typeof identity.dev === "bigint" &&
    typeof identity.ino === "bigint" &&
    typeof identity.size === "bigint" &&
    typeof identity.mtimeNs === "bigint" &&
    typeof identity.ctimeNs === "bigint" &&
    typeof identity.sha256 === "string" &&
    HEX_SHA256.test(identity.sha256) &&
    typeof identity.nativeImage === "boolean"
  );
}

function engineBindingKey(): string {
  return [
    process.env.SWEEP_ENGINE_PATH ?? "",
    process.env.PATH ?? "",
    process.env.PATHEXT ?? "",
    embeddedEngine ? "embedded" : "",
  ].join("\0");
}

/**
 * Resolve the native engine, check who can modify it, and return the bound
 * identity. Called before every native engine spawn.
 *
 * @throws RustEngineMissingError when no engine file resolves
 * @throws EngineIdentityError when the engine is untrusted, unreadable, a
 *   script without the development opt-in, or not the bound engine
 */
export function acquireRustEngine(): AcquiredRustEngine {
  const resolved = resolveRustEngineExecutable();
  if (!resolved.executable)
    throw new RustEngineMissingError(
      missingRustEngineMessage(resolved.binary, resolved.explicitConfigured),
    );
  const { bindings } = sharedEngineState();
  const key = engineBindingKey();
  const bound: unknown = bindings.get(key);
  if (bound === undefined) {
    const identity = captureEngineIdentity(resolved.executable);
    bindings.set(
      key,
      Object.freeze({ file: resolved.executable, identity: Object.freeze(identity) }),
    );
    return { binary: resolved.binary, file: resolved.executable, identity };
  }
  if (!validBinding(bound))
    throw new EngineIdentityError(
      "The native engine binding for this process is not recognized",
      "unreadable",
    );
  const current = inspectEngineFile(resolved.executable);
  if (resolved.executable !== bound.file || !sameEngineFile(current, bound.identity))
    throw new EngineIdentityError(
      `The native engine changed after sweep checked it: it checked ${bound.identity.path} ` +
        `but would now run ${current.path}`,
      "changed",
    );
  return { binary: resolved.binary, file: bound.file, identity: bound.identity };
}

/** Message for a scan or other non-destructive use that cannot get an engine. */
function engineUseError(error: unknown): Error {
  if (error instanceof RustEngineMissingError)
    return new Error(
      `${error.message} Install the native engine, set SWEEP_ENGINE_PATH, or use --engine js.`,
    );
  if (error instanceof EngineIdentityError)
    return new GuardrailError(
      error.issue === "changed"
        ? `${error.message}. Restart sweep so it checks the engine again.`
        : `${error.message}.`,
    );
  return error instanceof Error ? error : new Error(String(error));
}

/** Run `--capabilities` on the bound engine; undefined when it cannot answer. */
export function readRustEngineCapabilities(): Record<string, unknown> | undefined {
  let engine: AcquiredRustEngine;
  try {
    engine = acquireRustEngine();
  } catch {
    return undefined;
  }
  const result = spawnSync(engine.identity.path, ["--capabilities"], {
    encoding: "utf8",
    timeout: 1000,
    killSignal: "SIGKILL",
    maxBuffer: 4096,
  });
  if (result.error || result.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** @internal Test seam: forget bound engines and the cached probe. */
export function resetRustEngineBindingsForTest(): void {
  const state = sharedEngineState();
  state.bindings.clear();
  state.availability = undefined;
}

interface RunEngineOptions {
  cwd?: string | undefined;
  executable?: string | undefined;
  signal?: AbortSignal | undefined;
  cooperativeApply?: boolean;
  waitForConsumer?: (() => Promise<void> | undefined) | undefined;
  /**
   * Runs synchronously right after spawn, before the child receives any input.
   * Throwing kills the child and rejects with that error.
   */
  verifySpawned?: ((pid: number) => void) | undefined;
}

/** A plan with 100k candidates is ~20 MB; this bound leaves generous room. */
const MAX_ENGINE_STDOUT = 64 * 1024 * 1024;
/** stderr only matters for the error message - the tail is what we print. */
const MAX_ENGINE_STDERR = 64 * 1024;
/** Streamed scan events are one JSON object per line; this is generous. */
const MAX_EVENT_LINE = 4 * 1024 * 1024;

/**
 * SIGTERM first so the engine can flush; SIGKILL if it ignores the signal.
 * Leaving a live `sweep-engine` child after Ctrl+C is what hangs `sweep ui`.
 */
function terminateEngine(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  const forceKill = setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
    }
  }, 250);
  forceKill.unref();
  proc.once("close", () => clearTimeout(forceKill));
}

/**
 * Spawn the Rust engine asynchronously so the JS event loop stays live while
 * it runs (spinners keep animating, progress hooks fire in real time).
 * Resolves with full stdout once the process exits successfully.
 */
async function runEngineAsync(
  args: string[],
  stdin?: string,
  onLine?: (line: string) => void,
  options: RunEngineOptions = {},
): Promise<string> {
  let binary: string;
  let executable: string;
  if (options.executable) {
    binary = executable = options.executable;
  } else {
    try {
      const engine = acquireRustEngine();
      binary = engine.binary;
      executable = engine.identity.path;
    } catch (error) {
      throw engineUseError(error);
    }
  }
  const proc = spawn(executable, args, {
    cwd: options.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    // Terminal Ctrl+C must reach the host, not kill apply before its report.
    // Keep the child referenced and its pipes open; this is not a daemon.
    detached: options.cooperativeApply === true && process.platform !== "win32",
  });

  if (options.verifySpawned && proc.pid !== undefined) {
    try {
      options.verifySpawned(proc.pid);
    } catch (error) {
      // Nothing has been written to stdin: the child never saw the request.
      proc.on("error", () => {});
      proc.stdin.on("error", () => {});
      proc.kill("SIGKILL");
      proc.stdin.destroy();
      throw error;
    }
  }

  return await new Promise<string>((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stdoutBytes = 0;
    let stderr = Buffer.alloc(0);
    const lines = onLine
      ? new NdjsonDecoder(onLine, options.cooperativeApply ? MAX_ENGINE_STDOUT : MAX_EVENT_LINE)
      : undefined;
    let settled = false;
    let consumerWork: Promise<void> = Promise.resolve();

    // A detached cooperative-apply child runs in its own process group, so
    // terminal job control (Ctrl+Z -> SIGTSTP) never reaches it. Without
    // forwarding, the host freezes while the deletion keeps running - the
    // worst possible lie. Forward stop to the child group, then SIGSTOP the
    // host (uncatchable, so the suspend is reliable); on resume the shell
    // SIGCONTs only the host, which then forwards SIGCONT to the child.
    const detachedGroup =
      options.cooperativeApply === true && process.platform !== "win32" && proc.pid !== undefined
        ? -proc.pid
        : 0;
    const onSigtstp = () => {
      try {
        process.kill(detachedGroup, "SIGTSTP");
      } catch {
        // Child group already gone.
      }
      process.kill(process.pid, "SIGSTOP");
    };
    const onSigcont = () => {
      try {
        process.kill(detachedGroup, "SIGCONT");
      } catch {
        // Child group already gone.
      }
    };
    if (detachedGroup !== 0) {
      process.on("SIGTSTP", onSigtstp);
      process.on("SIGCONT", onSigcont);
    }

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGTSTP", onSigtstp);
      process.removeListener("SIGCONT", onSigcont);
      fn();
    };

    proc.stdout.setEncoding("utf8");

    if (onLine) {
      proc.stdout.on("data", (chunk: string) => {
        if (settled) return;
        // Node resumes child stdout on exit, even when we paused it. Chain
        // work so that final pipe draining cannot overlap decoder slices.
        proc.stdout.pause();
        const work: Promise<void> = consumerWork
          .then(async () => {
            if (settled) return;
            await lines?.pushAsync(chunk);
            await options.waitForConsumer?.();
            // Only the last queued task owns resuming input. An older task
            // must not unpause the stream while its successor is waiting.
            if (!settled && consumerWork === work) proc.stdout.resume();
          })
          .catch((error) => {
            terminateEngine(proc);
            settle(() => rejectPromise(error));
          });
        consumerWork = work;
      });
    } else {
      proc.stdout.on("data", (chunk: string) => {
        if (settled) return;
        stdoutBytes += Buffer.byteLength(chunk, "utf8");
        // A misbehaving engine binary must not pin the host process - the
        // largest legitimate payload is a plan JSON, far under this bound.
        if (stdoutBytes > MAX_ENGINE_STDOUT) {
          terminateEngine(proc);
          settle(() =>
            rejectPromise(new Error(`rust engine output exceeded ${MAX_ENGINE_STDOUT} bytes`)),
          );
          return;
        }
        stdout += chunk;
      });
    }

    proc.stderr.on("data", (chunk: Buffer) => {
      const tail = chunk.subarray(-MAX_ENGINE_STDERR);
      const retained = stderr.subarray(
        Math.max(0, stderr.length + tail.length - MAX_ENGINE_STDERR),
      );
      stderr = Buffer.concat([retained, tail]);
    });
    // A stream-level error on a flowing pipe would otherwise escape as an
    // uncaughtException, bypassing the exit-code taxonomy entirely.
    proc.stdout.on("error", (error: Error) => {
      terminateEngine(proc);
      settle(() => rejectPromise(new Error(`rust engine stdout failed: ${error.message}`)));
    });
    proc.stderr.on("error", () => {
      // stderr is diagnostic-only - the close handler still reports exit.
    });

    proc.on("error", (error) => {
      settle(() =>
        rejectPromise(new Error(`failed to spawn rust engine at ${binary}: ${error.message}`)),
      );
    });

    proc.on("close", (code) => {
      void consumerWork.then(() => {
        if (settled) return;
        if (options.signal?.aborted && !options.cooperativeApply) {
          settle(() => resolvePromise(stdout));
          return;
        }
        if (code === 0) {
          try {
            lines?.finish();
          } catch (error) {
            settle(() => rejectPromise(error));
            return;
          }
          settle(() => resolvePromise(stdout));
        } else {
          // The engine exits with the CLI's taxonomy (2 guardrail, 3 invalid
          // input, 4 failure) so `sweep --engine rust` maps errors identically
          // to the JS engine instead of collapsing every failure to exit 4.
          const message =
            stderr.toString("utf8").trim() || `rust engine exited with status ${code ?? "signal"}`;
          settle(() =>
            rejectPromise(
              code === 2
                ? new GuardrailError(message, 2)
                : code === 3
                  ? new PlanValidationError(message)
                  : new Error(message),
            ),
          );
        }
      });
    });

    if (stdin !== undefined) {
      // Engine exiting early (bad config, bad args) can close the pipe while a
      // large payload is mid-write; swallow EPIPE here so the close-handler's
      // stderr-based error is what surfaces instead of an unhandled 'error'.
      proc.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE") return;
        terminateEngine(proc);
        settle(() =>
          rejectPromise(new Error(`failed to send request to rust engine: ${error.message}`)),
        );
      });
      proc.stdin.write(stdin);
    }
    if (!options.cooperativeApply) proc.stdin.end();
    const onAbort = () => {
      if (!options.cooperativeApply) {
        terminateEngine(proc);
        return;
      }
      // Finish the current removal and drain an authoritative outcome report.
      proc.stdin.end('{"type":"cancel"}\n');
      const watchdog = setTimeout(() => {
        proc.kill("SIGKILL");
        settle(() =>
          rejectPromise(
            new ApplyOutcomeUnknownError(
              "Apply cancellation timed out. Outcomes are unknown; inspect the tree before retrying.",
            ),
          ),
        );
      }, 30_000);
      watchdog.unref();
      proc.once("close", () => clearTimeout(watchdog));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    proc.once("close", () => options.signal?.removeEventListener("abort", onAbort));
    if (options.signal?.aborted) onAbort();
  });
}

export interface RustScanOptions extends ScanHooks {
  config: SweepConfig;
  selectionPolicy: SelectionPolicy;
  exact?: boolean;
}

/**
 * Scan via the Rust `sweep-engine` subprocess and parse a [`ScanPlan`].
 *
 * True streaming: `onEntry`/`onEntrySized` fire while the engine is still
 * running, so callers can render progress live.
 */
export async function scanToPlanViaRust(
  targetDir: string,
  options: RustScanOptions,
): Promise<ScanPlan> {
  const absoluteTarget = resolve(targetDir);
  const wantsStream =
    options.onStarted !== undefined ||
    options.onEntry !== undefined ||
    options.onEntrySized !== undefined ||
    options.onProgress !== undefined;
  const stdin = JSON.stringify({
    config: options.config,
    selectionPolicy: options.selectionPolicy ?? DEFAULT_SELECTION_POLICY,
    exact: options.exact ?? false,
    limits: { ...SCAN_RESOURCE_PROFILES[options.resourceProfile ?? "balanced"], ...options.limits },
    // No live hooks means nobody is watching candidates arrive - the engine
    // emits the whole plan in one write instead of serializing an event per
    // candidate. On big trees per-entry JSON was the dominant cost, not the
    // filesystem walk.
    jsonStream: wantsStream,
  });

  if (!wantsStream) {
    const scan = runEngineAsync(["scan", absoluteTarget], stdin, undefined, {
      signal: options.signal,
    });
    // Compile the plan validator while the subprocess scans - the cold AJV
    // compile (~100ms) hides entirely under the engine's walk.
    warmPlanValidator();
    const stdout = await scan;
    if (options.signal?.aborted) throw new GuardrailError("Scan interrupted", 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new PlanValidationError(
        `Invalid plan JSON from engine: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The streamed path reaches buildPlan -> applyPlanInsights, which demotes
    // workspace stubs and symlink aliases and recomputes the selection set.
    // The engine's one-shot plan does none of that - run the same pass here
    // so `--engine rust` and streamed/JS plans select identical ids.
    const enriched = await applyPlanInsights(
      validatePlan(parsed),
      options.signal ? { signal: options.signal } : undefined,
    );
    if (options.signal?.aborted) throw new GuardrailError("Scan interrupted", 1);
    return enriched;
  }

  const stream = new RustScanStream(absoluteTarget, options, options.exact ?? false);
  await runEngineAsync(["scan", absoluteTarget], stdin, (line) => stream.push(line), {
    signal: options.signal,
    waitForConsumer: options.waitForConsumer,
  });
  if (options.signal?.aborted) throw new GuardrailError("Scan interrupted", 1);
  const enriched = await buildPlan(
    absoluteTarget,
    stream.finish(),
    options.selectionPolicy ?? DEFAULT_SELECTION_POLICY,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (options.signal?.aborted) throw new GuardrailError("Scan interrupted", 1);
  return enriched;
}

/** Apply via the Rust `sweep-engine` subprocess. */
export async function applyPlanViaRust(
  plan: ScanPlan,
  signal?: AbortSignal,
  onDeleted?: (id: string) => void,
  maxSizeBytes?: number,
  onBegin?: (id: string) => void,
  onPreparing?: (id: string, completed: number, total: number) => void,
  onActivity?: (id: string, removedEntries: number) => void,
): Promise<ApplyReport> {
  if (maxSizeBytes !== undefined && (!Number.isSafeInteger(maxSizeBytes) || maxSizeBytes < 0))
    throw new GuardrailError("Invalid native size ceiling; expected a nonnegative safe integer");
  const selected = new Set(plan.selectedCandidateIds);
  if (signal?.aborted) {
    return {
      protocolVersion: plan.protocolVersion,
      targetDir: plan.targetDir,
      selectedCandidateIds: [...selected],
      deletedCount: 0,
      failedCount: 0,
      totalBytesFreed: 0,
      failedPaths: [],
      interrupted: true,
      outcomes: [...selected].map((candidateId) => ({ candidateId, status: "unattempted" })),
    };
  }
  // The engine bound for this operation (see acquireRustEngine): the file
  // the auto probe selected, or the first one used under --engine rust.
  let engine: EngineIdentity;
  let binary: string;
  try {
    const acquired = acquireRustEngine();
    engine = acquired.identity;
    binary = acquired.binary;
  } catch (error) {
    if (error instanceof RustEngineMissingError)
      throw new ApplyRefusedError(
        `${error.message} Repair or reinstall the native engine, or use --engine js, then review again. Nothing was removed.`,
        "engine_unavailable",
      );
    throw engineIdentityRefusal(error);
  }
  const capabilities = spawnSync(engine.path, ["--capabilities"], {
    encoding: "utf8",
    timeout: 1000,
    killSignal: "SIGKILL",
    maxBuffer: 4096,
  });
  // Distinguish "binary cannot run" (ENOENT/EPERM spawn error) from "ran but
  // lacks applyControl" (old engine): same flag, different remedy.
  if (capabilities.error) {
    throw new ApplyRefusedError(
      `Could not run the Rust engine at ${binary}: ${capabilities.error.message}. ` +
        `Repair or reinstall the native engine, then review again. Nothing was removed.`,
      "engine_unavailable",
    );
  }
  let controlled = false;
  let identityChecked = false;
  let preflightProgress = false;
  let removalProgress = false;
  try {
    const supported = JSON.parse(capabilities.stdout);
    controlled = capabilities.status === 0 && supported.applyControl === true;
    identityChecked = capabilities.status === 0 && supported.planIdentity === true;
    preflightProgress = capabilities.status === 0 && supported.applyPreparation === true;
    removalProgress =
      capabilities.status === 0 && supported.applyActivity === true && onActivity !== undefined;
  } catch {
    /* older engine */
  }
  if (!controlled)
    throw new ApplyRefusedError(
      "This Rust engine lacks safe apply cancellation. Update the native package, then review again. Nothing was removed.",
      "engine_unavailable",
    );
  if (!identityChecked)
    throw new ApplyRefusedError(
      "This Rust engine lacks saved-plan identity checks. Update the native package, then review again. Nothing was removed.",
      "engine_unavailable",
    );
  let report: ApplyReport | undefined;
  let refusal: ApplyRefusedError | undefined;
  let preparedCount = 0;
  let activeActivityId: string | undefined;
  let activityCount = 0;
  const progress = new Set<string>();
  const began = new Set<string>();
  // Omit presentation-only worktree and unique-byte metadata from the native
  // apply payload so older native engines (with `deny_unknown_fields`) accept
  // v1 plans cleanly.
  const {
    uniqueTotalBytes: _uniqueTotalBytes,
    uniqueBytesPartial: _uniqueBytesPartial,
    ...applySummary
  } = plan.summary;
  const applyPayloadPlan: ScanPlan = {
    ...plan,
    summary: applySummary,
    candidates: plan.candidates.map(
      ({
        worktreeOf: _worktreeOf,
        worktreeState: _worktreeState,
        uniqueBytes: _uniqueBytes,
        ...candidate
      }) => candidate,
    ),
  };
  const request = `${JSON.stringify({ plan: applyPayloadPlan, maxSizeBytes, ...(preflightProgress ? { preflightProgress: true } : {}), ...(removalProgress ? { removalProgress: true } : {}) })}\n{"type":"start"}\n`;
  // Last check before the destructive spawn, after the (possibly large)
  // payload is serialized: same file, same bytes (fresh read).
  try {
    assertEngineContent(engine);
  } catch (error) {
    throw engineIdentityRefusal(error);
  }
  try {
    await runEngineAsync(
      ["apply", "--json-control"],
      request,
      (line) => {
        let event: {
          type?: string;
          candidateId?: string;
          report?: unknown;
          code?: unknown;
          message?: unknown;
          completed?: unknown;
          total?: unknown;
          removedEntries?: unknown;
        };
        try {
          event = JSON.parse(line) as typeof event;
        } catch {
          throw new PlanValidationError("Invalid apply event JSON from engine");
        }
        if (report || refusal) throw new PlanValidationError("Apply event after completion");
        if (event.type === "apply_refused") {
          if (
            began.size !== 0 ||
            typeof event.message !== "string" ||
            event.message.length > 4096 ||
            (event.code !== "size_limit_exceeded" && event.code !== "current_size_unavailable")
          )
            throw new PlanValidationError("Invalid apply refusal");
          const detail =
            event.code === "size_limit_exceeded"
              ? `Current selection exceeds the configured ${((maxSizeBytes ?? 0) / 1024 ** 3).toFixed(1)} GiB limit. Reduce the queue, raise maxSizeGB in .sweeprc, or restart with --force-large --yes. Nothing removed.`
              : "Cannot verify current size; rescan or restart with --force-large --yes. Nothing removed.";
          refusal = new ApplyRefusedError(detail, event.code);
          return;
        }
        if (event.type === "apply_preparing") {
          if (
            began.size > 0 ||
            typeof event.candidateId !== "string" ||
            !selected.has(event.candidateId) ||
            !Number.isSafeInteger(event.completed) ||
            !Number.isSafeInteger(event.total) ||
            (event.completed as number) < preparedCount ||
            (event.completed as number) > (event.total as number) ||
            (event.total as number) > selected.size ||
            (event.total as number) <= 0
          )
            throw new PlanValidationError("Invalid apply preparation progress");
          preparedCount = event.completed as number;
          onPreparing?.(event.candidateId, preparedCount, event.total as number);
        } else if (event.type === "apply_begin") {
          if (
            typeof event.candidateId !== "string" ||
            !selected.has(event.candidateId) ||
            began.has(event.candidateId)
          )
            throw new PlanValidationError("Invalid apply begin identity");
          began.add(event.candidateId);
          activeActivityId = event.candidateId;
          activityCount = 0;
          onBegin?.(event.candidateId);
        } else if (event.type === "apply_activity") {
          if (
            !removalProgress ||
            typeof event.candidateId !== "string" ||
            event.candidateId !== activeActivityId ||
            progress.has(event.candidateId) ||
            !Number.isSafeInteger(event.removedEntries) ||
            (event.removedEntries as number) <= activityCount
          ) {
            throw new PlanValidationError("Invalid removal activity");
          }
          activityCount = event.removedEntries as number;
          onActivity?.(event.candidateId, activityCount);
        } else if (event.type === "apply_deleted") {
          if (
            typeof event.candidateId !== "string" ||
            !began.has(event.candidateId) ||
            progress.has(event.candidateId)
          ) {
            throw new PlanValidationError("Invalid apply progress identity");
          }
          progress.add(event.candidateId);
          if (activeActivityId === event.candidateId) activeActivityId = undefined;
          onDeleted?.(event.candidateId);
        } else if (event.type === "apply_completed") {
          report = validateApplyReport(event.report);
        } else throw new PlanValidationError("Invalid apply event");
      },
      {
        signal,
        cooperativeApply: true,
        executable: engine.path,
        verifySpawned: (pid) => {
          try {
            assertSpawnedEngine(pid, engine);
          } catch (error) {
            throw engineIdentityRefusal(error);
          }
        },
      },
    );
    if (refusal) throw refusal;
    if (!report?.outcomes || report.targetDir !== plan.targetDir)
      throw new PlanValidationError("Missing authoritative apply report");
    const ids = new Set(report.outcomes.map((outcome) => outcome.candidateId));
    const deleted = new Set(
      report.outcomes
        .filter((outcome) => outcome.status === "deleted")
        .map((outcome) => outcome.candidateId),
    );
    const candidatesById = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
    const estimatedRemoved = [...deleted].reduce(
      (sum, id) => sum + (candidatesById.get(id)?.estimatedBytes ?? 0),
      0,
    );
    if (
      report.totalBytesFreed !== estimatedRemoved ||
      ids.size !== report.outcomes.length ||
      report.selectedCandidateIds.length !== selected.size ||
      new Set(report.selectedCandidateIds).size !== selected.size ||
      report.selectedCandidateIds.some((id) => !selected.has(id)) ||
      ids.size !== selected.size ||
      [...ids].some((id) => !selected.has(id)) ||
      report.deletedCount !== deleted.size ||
      report.failedCount !== report.failedPaths.length ||
      report.outcomes.filter((outcome) => outcome.status === "failed").length !==
        report.failedCount ||
      deleted.size !== progress.size ||
      [...deleted].some((id) => !progress.has(id)) ||
      report.outcomes.some((outcome) =>
        outcome.status === "covered"
          ? !outcome.coveredBy || !deleted.has(outcome.coveredBy)
          : outcome.coveredBy !== undefined,
      )
    ) {
      throw new PlanValidationError("Inconsistent apply outcome partition");
    }
    return report;
  } catch (error) {
    if (refusal && !(error instanceof PlanValidationError) && began.size === 0) throw refusal;
    if (began.size > 0) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ApplyOutcomeUnknownError(
        `Native apply did not return a trusted outcome report. Outcomes are unknown; inspect the tree before retrying. ${detail}`,
      );
    }
    throw error;
  }
}

function engineIdentityRefusal(error: unknown): ApplyRefusedError {
  const detail = error instanceof Error ? error.message : String(error);
  const issue = error instanceof EngineIdentityError ? error.issue : undefined;
  // An untrusted-engine message already says how to proceed.
  const remedy =
    issue === "changed"
      ? "Restart sweep and review again so it checks the engine again."
      : issue === "untrusted"
        ? "Then review again."
        : "Repair or reinstall the native engine, or use --engine js, then review again.";
  return new ApplyRefusedError(`${detail}. ${remedy} Nothing was removed.`, "engine_unavailable");
}

export type RustEngineUnavailableKind =
  | "not_installed"
  | "untrusted"
  | "changed"
  | "spawn_error"
  | "probe_failed"
  | "timeout";

export interface RustEngineProbeResult {
  available: boolean;
  binary: string;
  /** Exact absolute executable file inspected by the probe when present on disk. */
  resolvedPath?: string;
  reasonKind?: RustEngineUnavailableKind;
  /** Concise single-line explanation of why the probe failed (status, signal, first stderr line). */
  reason?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderrFirstLine?: string;
}

function firstNonEmptyLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 240);
  }
  return undefined;
}

// Cache only the last resolved binary (shared across bundled copies; see
// sharedEngineState); replacements and environment changes
// invalidate the probe. Bound runtime/output even for user-supplied binaries.

export function probeRustEngine(): RustEngineProbeResult {
  const state = sharedEngineState();
  const explicitConfigured = Boolean(process.env.SWEEP_ENGINE_PATH);
  const binary = resolveRustEngineBinary();
  let key = `${explicitConfigured ? "env:" : ""}${binary}:${process.cwd()}:${process.env.PATH ?? ""}:${process.env.PATHEXT ?? ""}`;
  const lookup = lookupExecutable(binary);
  const file = lookup.resolvedPath ?? lookup.nonExecutablePath;
  try {
    if (!file) {
      const configuredMiss = explicitConfigured || isExplicitBinaryPath(binary);
      const result: RustEngineProbeResult = configuredMiss
        ? {
            available: false,
            binary,
            reasonKind: "spawn_error",
            reason: `Configured Rust engine path was not found: ${binary}.`,
          }
        : {
            available: false,
            binary,
            reasonKind: "not_installed",
            reason: "Native Rust engine binary was not found.",
          };
      state.availability = { key, result };
      return result;
    }
    // Binds the engine for this operation on first use (see acquireRustEngine).
    let inspected: EngineIdentity;
    try {
      inspected = acquireRustEngine().identity;
    } catch (error) {
      if (!(error instanceof EngineIdentityError) || error.issue === "unreadable") throw error;
      state.availability = undefined;
      return {
        available: false,
        binary,
        resolvedPath: file,
        reasonKind: error.issue,
        reason: error.message,
      };
    }
    key += `:${file}:${inspected.path}:${inspected.dev}:${inspected.ino}:${inspected.size}:${inspected.mtimeNs}:${inspected.ctimeNs}`;
    // Cold runs pay the probe spawn every time - the memo would answer
    // instantly and make dev timings read warmer than a real cold start.
    if (!isColdRequested() && state.availability?.key === key) return state.availability.result;

    // Spawn the exact resolved file we just inspected, never the bare name.
    const proc = spawnSync(inspected.path, ["--version"], {
      encoding: "utf8",
      timeout: 1000,
      killSignal: "SIGKILL",
      maxBuffer: 4096,
    });
    if (!proc.error && proc.status === 0) {
      const result: RustEngineProbeResult = {
        available: true,
        binary,
        resolvedPath: file,
      };
      state.availability = { key, result };
      return result;
    }

    const stderrFirstLine = firstNonEmptyLine(
      typeof proc.stderr === "string" ? proc.stderr : undefined,
    );
    let reasonKind: RustEngineUnavailableKind = "probe_failed";
    let reason: string;
    if (proc.error) {
      const errCode = (proc.error as NodeJS.ErrnoException).code;
      if (errCode === "ETIMEDOUT") {
        reasonKind = "timeout";
        reason = stderrFirstLine
          ? `probe timed out after 1000ms: ${stderrFirstLine}`
          : "probe timed out after 1000ms";
      } else {
        reasonKind = "spawn_error";
        reason = proc.error.message;
      }
    } else if (proc.signal) {
      reason = stderrFirstLine
        ? `killed by ${proc.signal}: ${stderrFirstLine}`
        : `killed by ${proc.signal}`;
    } else {
      const statusLabel = `exited with status ${proc.status ?? "unknown"}`;
      reason = stderrFirstLine ? `${statusLabel}: ${stderrFirstLine}` : statusLabel;
    }

    const result: RustEngineProbeResult = {
      available: false,
      binary,
      resolvedPath: file,
      reasonKind,
      reason,
      exitCode: proc.status,
      signal: proc.signal,
      ...(stderrFirstLine ? { stderrFirstLine } : {}),
    };
    state.availability = { key, result };
    return result;
  } catch (error) {
    const result: RustEngineProbeResult = {
      available: false,
      binary,
      ...(file ? { resolvedPath: file } : {}),
      reasonKind: "spawn_error",
      reason: error instanceof Error ? error.message : String(error),
    };
    state.availability = { key, result };
    return result;
  }
}

export function isRustEngineAvailable(): boolean {
  return probeRustEngine().available;
}

/**
 * When non-null, the Rust scan subprocess cannot honor the requested scan and
 * callers should fall back to the JS engine. Returns null when Rust can run
 * (including custom patterns, ignore rules, depth, exact sizing, and hooks).
 */
export function rustScanBlockedReason(
  _config: SweepConfig,
  _projectConfig: SweepConfig,
  _options: ScanToPlanOptions,
): string | null {
  return null;
}

/** Default selection policy forwarded to Rust when callers omit one explicitly. */
export function defaultRustSelectionPolicy(options: ScanToPlanOptions): SelectionPolicy {
  return options.selectionPolicy ?? DEFAULT_SELECTION_POLICY;
}
