import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApplyReport, ScanPlan } from "@kitsunekode/sweep-protocol";

export type EngineBackend = "js" | "rust";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Resolve the `sweep-engine` binary used for Rust backend subprocess calls.
 *
 * Resolution order:
 * 1. `SWEEP_ENGINE_PATH` environment variable
 * 2. `target/debug/sweep-engine` in the repo root (local dev build)
 * 3. `sweep-engine` on `PATH`
 */
export function resolveRustEngineBinary(): string {
  const fromEnv = process.env.SWEEP_ENGINE_PATH;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }

  const localDebug = join(REPO_ROOT, "target", "debug", "sweep-engine");
  if (existsSync(localDebug)) {
    return localDebug;
  }

  return "sweep-engine";
}

function runEngine(args: string[], stdin?: string): string {
  const binary = resolveRustEngineBinary();
  const proc = spawnSync(binary, args, {
    cwd: REPO_ROOT,
    input: stdin,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (proc.error) {
    throw new Error(`failed to spawn rust engine at ${binary}: ${proc.error.message}`);
  }

  if (proc.status !== 0) {
    const stderr = proc.stderr?.trim() || "rust engine exited with a non-zero status";
    throw new Error(stderr);
  }

  return proc.stdout;
}

/** Scan via the Rust `sweep-engine` subprocess and parse a [`ScanPlan`]. */
export function scanToPlanViaRust(targetDir: string): ScanPlan {
  const absoluteTarget = resolve(targetDir);
  const stdout = runEngine(["scan", absoluteTarget]);
  return JSON.parse(stdout) as ScanPlan;
}

/** Apply via the Rust `sweep-engine` subprocess. */
export function applyPlanViaRust(plan: ScanPlan): ApplyReport {
  const stdout = runEngine(["apply"], JSON.stringify(plan));
  return JSON.parse(stdout) as ApplyReport;
}

export function isRustEngineAvailable(): boolean {
  try {
    const binary = resolveRustEngineBinary();
    if (binary !== "sweep-engine" && !existsSync(binary)) {
      return false;
    }
    const proc = spawnSync(binary, [], { encoding: "utf8" });
    return proc.status !== 0 && (proc.stderr?.includes("usage:") ?? false);
  } catch {
    return false;
  }
}
