import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ApplyReport,
  ScanCandidate,
  ScanCompletedEvent,
  ScanEntry,
  ScanEvent,
  ScanPlan,
  SelectionPolicy,
  SweepConfig,
} from "@kitsunekode/sweep-protocol";
import { DEFAULT_SELECTION_POLICY } from "@kitsunekode/sweep-protocol";
import { buildPlan } from "./planner.js";
import type { ScanHooks } from "./scanner.js";
import type { ScanToPlanOptions } from "./engine.js";
import { nativePlatformForCurrentProcess } from "./native-platforms.js";

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
 * 2. Installed optional `@kitsunekode/sweep-engine-*` platform package
 * 3. `target/debug/sweep-engine` or `target/release/sweep-engine` under package root (dev)
 * 4. `sweep-engine` on `PATH`
 */
export function resolveRustEngineBinary(): string {
  const fromEnv = process.env.SWEEP_ENGINE_PATH;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }

  const packageRoot = sweepPackageRoot();

  const fromOptional = resolveOptionalNativeBinary(packageRoot);
  if (fromOptional) {
    return fromOptional;
  }

  for (const profile of ["debug", "release"] as const) {
    const local = join(packageRoot, "target", profile, "sweep-engine");
    if (existsSync(local)) {
      return local;
    }
  }

  const localWindows = join(packageRoot, "target", "debug", "sweep-engine.exe");
  if (existsSync(localWindows)) {
    return localWindows;
  }

  return "sweep-engine";
}

interface RunEngineOptions {
  cwd?: string;
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

  return await new Promise<string>((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    if (onLine) {
      const lines = createInterface({ input: proc.stdout });
      lines.on("line", (line) => {
        stdout += `${line}\n`;
        if (line.length > 0) onLine(line);
      });
    } else {
      proc.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }

    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    proc.on("error", (error) => {
      rejectPromise(new Error(`failed to spawn rust engine at ${binary}: ${error.message}`));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        rejectPromise(
          new Error(stderr.trim() || `rust engine exited with status ${code ?? "signal"}`),
        );
      }
    });

    if (stdin !== undefined) {
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

function scanEntryFromCandidate(candidate: ScanCandidate): ScanEntry {
  return {
    path: candidate.path,
    name: candidate.name,
    estimatedBytes: candidate.estimatedBytes,
    isSymlink: candidate.isSymlink,
    entryType: candidate.entryType,
  };
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
  const stdin = JSON.stringify({
    config: options.config,
    selectionPolicy: options.selectionPolicy ?? DEFAULT_SELECTION_POLICY,
    exact: options.exact ?? false,
    jsonStream: true,
  });

  const entriesByPath = new Map<string, ScanEntry>();
  // Holder object: TS narrows plain `let` captures even when callbacks assign them.
  const state: { summary: ScanCompletedEvent["summary"] | null } = { summary: null };
  let exact = options.exact ?? false;

  await runEngineAsync(["scan", absoluteTarget], stdin, (line) => {
    let event: ScanEvent & { summary?: ScanCompletedEvent["summary"] & { exact?: boolean } };
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.type === "candidate_found") {
      options.onEntry?.(scanEntryFromCandidate(event.candidate));
    } else if (event.type === "candidate_updated") {
      const entry = scanEntryFromCandidate(event.candidate);
      entriesByPath.set(entry.path, entry);
      options.onEntrySized?.(entry);
    } else if (event.type === "scan_completed") {
      state.summary = event.summary;
      if ("exact" in event.summary && typeof event.summary.exact === "boolean") {
        exact = event.summary.exact;
      }
    }
  });

  const entries = [...entriesByPath.values()];
  const completed = state.summary;
  const estimatedTotalBytes =
    completed?.estimatedTotalBytes ?? entries.reduce((sum, entry) => sum + entry.estimatedBytes, 0);

  return buildPlan(
    absoluteTarget,
    {
      entries,
      estimatedTotalBytes,
      scannedDirs: completed?.scannedDirs ?? 0,
      exact,
    },
    options.selectionPolicy ?? DEFAULT_SELECTION_POLICY,
  );
}

/** Apply via the Rust `sweep-engine` subprocess. */
export async function applyPlanViaRust(plan: ScanPlan): Promise<ApplyReport> {
  const stdout = await runEngineAsync(["apply"], JSON.stringify(plan));
  return JSON.parse(stdout) as ApplyReport;
}

export function isRustEngineAvailable(): boolean {
  try {
    const binary = resolveRustEngineBinary();
    if (binary !== "sweep-engine" && !existsSync(binary)) {
      return false;
    }
    const proc = spawnSync(binary, ["--version"], { encoding: "utf8" });
    return proc.status === 0;
  } catch {
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
