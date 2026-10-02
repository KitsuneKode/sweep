import { existsSync, readFileSync, statSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ApplyReport,
  ScanPlan,
  SelectionPolicy,
  SweepConfig,
} from "@kitsunekode/sweep-protocol";
import { DEFAULT_SELECTION_POLICY } from "@kitsunekode/sweep-protocol";
import { isColdRequested } from "./cold.js";
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
  if (embeddedEngine) return embeddedEngine();

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
  cooperativeApply?: boolean;
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
  const binary = resolveRustEngineBinary();
  const proc = spawn(binary, args, {
    cwd: options.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    // Terminal Ctrl+C must reach the host, not kill apply before its report.
    // Keep the child referenced and its pipes open; this is not a daemon.
    detached: options.cooperativeApply === true && process.platform !== "win32",
  });

  return await new Promise<string>((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    const lines = onLine
      ? new NdjsonDecoder(onLine, options.cooperativeApply ? MAX_ENGINE_STDOUT : MAX_EVENT_LINE)
      : undefined;
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
            new GuardrailError(
              "Apply cancellation timed out. Outcomes are unknown; inspect the tree before retrying.",
              1,
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
    options.onEntry !== undefined ||
    options.onEntrySized !== undefined ||
    options.onProgress !== undefined;
  const stdin = JSON.stringify({
    config: options.config,
    selectionPolicy: options.selectionPolicy ?? DEFAULT_SELECTION_POLICY,
    exact: options.exact ?? false,
    limits: options.limits,
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
export async function applyPlanViaRust(
  plan: ScanPlan,
  signal?: AbortSignal,
  onDeleted?: (id: string) => void,
  maxSizeBytes?: number,
  onBegin?: (id: string) => void,
): Promise<ApplyReport> {
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
  const binary = resolveRustEngineBinary();
  const capabilities = spawnSync(binary, ["--capabilities"], {
    encoding: "utf8",
    timeout: 1000,
    killSignal: "SIGKILL",
    maxBuffer: 4096,
  });
  let controlled = false;
  try {
    controlled = capabilities.status === 0 && JSON.parse(capabilities.stdout).applyControl === true;
  } catch {
    /* older engine */
  }
  if (!controlled)
    throw new GuardrailError(
      "This Rust engine lacks safe apply cancellation. Update the native package or use --engine js.",
    );
  let report: ApplyReport | undefined;
  const progress = new Set<string>();
  const began = new Set<string>();
  try {
    await runEngineAsync(
      ["apply", "--json-control"],
      `${JSON.stringify({ plan, maxSizeBytes })}\n{"type":"start"}\n`,
      (line) => {
        const event = JSON.parse(line) as { type?: string; candidateId?: string; report?: unknown };
        if (report) throw new PlanValidationError("Apply event after completion");
        if (event.type === "apply_begin") {
          if (
            typeof event.candidateId !== "string" ||
            !selected.has(event.candidateId) ||
            began.has(event.candidateId)
          )
            throw new PlanValidationError("Invalid apply begin identity");
          began.add(event.candidateId);
          onBegin?.(event.candidateId);
        } else if (event.type === "apply_deleted") {
          if (
            typeof event.candidateId !== "string" ||
            !began.has(event.candidateId) ||
            progress.has(event.candidateId)
          ) {
            throw new PlanValidationError("Invalid apply progress identity");
          }
          progress.add(event.candidateId);
          onDeleted?.(event.candidateId);
        } else if (event.type === "apply_completed") {
          report = validateApplyReport(event.report);
        } else throw new PlanValidationError("Invalid apply event");
      },
      { signal, cooperativeApply: true },
    );
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
    if (began.size > 0) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GuardrailError(
        `Native apply did not return a trusted outcome report. Outcomes are unknown; inspect the tree before retrying. ${detail}`,
        1,
      );
    }
    throw error;
  }
}

// Cache only the last resolved binary; replacements and environment changes
// invalidate the probe. Bound runtime/output even for user-supplied binaries.
let availability: { key: string; available: boolean } | undefined;
export function isRustEngineAvailable(): boolean {
  const binary = resolveRustEngineBinary();
  let key = `${binary}:${process.cwd()}:${process.env.PATH ?? ""}:${process.env.PATHEXT ?? ""}`;
  const extensions =
    process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD").split(";")] : [""];
  const file =
    binary.includes("/") || binary.includes("\\")
      ? resolve(binary)
      : (process.env.PATH ?? "")
          .split(delimiter)
          .flatMap((dir) => extensions.map((ext) => join(dir, binary + ext)))
          .find((path) => existsSync(path));
  try {
    if (!file) {
      availability = { key, available: false };
      return false;
    }
    if (file) {
      const stat = statSync(file, { bigint: true });
      key += `:${file}`;
      key += `:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    }
    // Cold runs pay the probe spawn every time - the memo would answer
    // instantly and make dev timings read warmer than a real cold start.
    if (!isColdRequested() && availability?.key === key) return availability.available;
    const proc = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 1000,
      killSignal: "SIGKILL",
      maxBuffer: 4096,
    });
    const available = proc.status === 0;
    availability = { key, available };
    return available;
  } catch {
    availability = { key, available: false };
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
