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
import { GuardrailError } from "./guardrails.js";
import { buildPlan } from "./planner.js";
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

/**
 * Root of the published `@kitsunekode/sweep` npm package (`apps/cli`), or the monorepo in dev.
 *
 * - Bundled CLI (`apps/cli/dist/sweep.js`): parent of `dist/`
 * - Dev (`packages/core/src/...`): walk up to `package.json` named `@kitsunekode/sweep`
 */
export function sweepPackageRoot(fromModuleDir: string = MODULE_DIR): string {
  const normalized = fromModuleDir.replace(/\\/g, "/");

  if (normalized.includes("/dist")) {
    const distIndex = normalized.lastIndexOf("/dist");
    return resolve(normalized.slice(0, distIndex));
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
 * Resolve the `sweep-engine` binary used for Rust backend subprocess calls.
 *
 * Resolution order:
 * 1. `SWEEP_ENGINE_PATH` environment variable
 * 2. Workspace `target/{debug,release}/sweep-engine` (dev builds must shadow
 *    the installed optional package - otherwise local Rust changes are never
 *    exercised by tests or dev runs while `cargo test` validates other code)
 * 3. Installed optional `@kitsunekode/sweep-engine-*` platform package
 * 4. `sweep-engine` on `PATH`
 */
export function resolveRustEngineBinary(): string {
  const fromEnv = process.env.SWEEP_ENGINE_PATH;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }

  const packageRoot = sweepPackageRoot();
  const binaryName = process.platform === "win32" ? "sweep-engine.exe" : "sweep-engine";

  // Cargo workspace builds land in <repo>/target, not <repo>/apps/cli/target -
  // walk up so a local build is found from either layout. The Cargo.toml gate
  // keeps this scoped to real source checkouts: a published install or an
  // unrelated ~/target/debug/sweep-engine must not shadow the package binary.
  // Newest build wins - a stale target/release artifact must not beat a fresh
  // cargo build --profile dev.
  for (let dir = packageRoot, depth = 0; depth < 4; depth++) {
    if (existsSync(join(dir, "Cargo.toml"))) {
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

  return "sweep-engine";
}

interface RunEngineOptions {
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** A plan with 100k candidates is ~20 MB; this bound leaves generous room. */
const MAX_ENGINE_STDOUT = 256 * 1024 * 1024;
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
  const binary = resolveRustEngineBinary();
  const proc = spawn(binary, args, {
    cwd: options.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (options.signal) {
    if (options.signal.aborted) {
      terminateEngine(proc);
    } else {
      const onAbort = () => terminateEngine(proc);
      options.signal.addEventListener("abort", onAbort, { once: true });
      proc.on("close", () => options.signal?.removeEventListener("abort", onAbort));
    }
  }

  return await new Promise<string>((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    const lines = onLine ? new NdjsonDecoder(onLine, MAX_EVENT_LINE) : undefined;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    if (onLine) {
      proc.stdout.on("data", (chunk: string) => {
        if (settled) return;
        try {
          lines?.push(chunk);
        } catch (error) {
          terminateEngine(proc);
          settle(() => rejectPromise(error));
        }
      });
    } else {
      proc.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        // A misbehaving engine binary must not pin the host process - the
        // largest legitimate payload is a plan JSON, far under this bound.
        if (stdout.length > MAX_ENGINE_STDOUT) {
          terminateEngine(proc);
          settle(() =>
            rejectPromise(new Error(`rust engine output exceeded ${MAX_ENGINE_STDOUT} bytes`)),
          );
        }
      });
    }

    proc.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_ENGINE_STDERR) {
        stderr += chunk;
      }
    });

    proc.on("error", (error) => {
      settle(() =>
        rejectPromise(new Error(`failed to spawn rust engine at ${binary}: ${error.message}`)),
      );
    });

    proc.on("close", (code) => {
      if (settled) return;
      if (options.signal?.aborted) {
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
        const message = stderr.trim() || `rust engine exited with status ${code ?? "signal"}`;
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
    proc.stdin.end();
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
    options.onEntry !== undefined ||
    options.onEntrySized !== undefined ||
    options.onProgress !== undefined;
  const stdin = JSON.stringify({
    config: options.config,
    selectionPolicy: options.selectionPolicy ?? DEFAULT_SELECTION_POLICY,
    exact: options.exact ?? false,
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
    return validatePlan(JSON.parse(stdout));
  }

  const stream = new RustScanStream(absoluteTarget, options, options.exact ?? false);
  await runEngineAsync(["scan", absoluteTarget], stdin, (line) => stream.push(line), {
    signal: options.signal,
  });
  if (options.signal?.aborted) throw new GuardrailError("Scan interrupted", 1);
  return buildPlan(
    absoluteTarget,
    stream.finish(),
    options.selectionPolicy ?? DEFAULT_SELECTION_POLICY,
  );
}

/** Apply via the Rust `sweep-engine` subprocess. */
export async function applyPlanViaRust(plan: ScanPlan, signal?: AbortSignal): Promise<ApplyReport> {
  const stdout = await runEngineAsync(["apply"], JSON.stringify(plan), undefined, { signal });
  try {
    return validateApplyReport(JSON.parse(stdout));
  } catch (error) {
    if (signal?.aborted) {
      // The engine was killed mid-run - partial deletions may have landed.
      throw new GuardrailError(
        "Apply interrupted. The engine was stopped mid-run; some deletions may have completed.",
        1,
      );
    }
    throw error;
  }
}

/**
 * Memoised: `auto` is the default engine flag, so this probe now runs on every
 * command - it must not pay a subprocess spawn more than once per process.
 */
let rustEngineAvailable: boolean | undefined;

export function isRustEngineAvailable(): boolean {
  if (rustEngineAvailable !== undefined) return rustEngineAvailable;
  try {
    const binary = resolveRustEngineBinary();
    if (binary !== "sweep-engine" && !existsSync(binary)) {
      rustEngineAvailable = false;
      return false;
    }
    const proc = spawnSync(binary, ["--version"], { encoding: "utf8" });
    rustEngineAvailable = proc.status === 0;
    return rustEngineAvailable;
  } catch {
    rustEngineAvailable = false;
    return false;
  }
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
