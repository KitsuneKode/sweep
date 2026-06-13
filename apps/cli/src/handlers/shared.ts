import { createInterface } from "node:readline";
import type {
  CliOptions,
  ScanPlan,
  ScanResult,
  SelectionMode,
  SelectionPolicy,
  SweepConfig,
} from "@kitsunekode/sweep-protocol";
import { loadConfig } from "@kitsunekode/sweep-core/config";
import { scanToPlan, type ScanToPlanOptions } from "@kitsunekode/sweep-core/engine";
import { assertSafePattern } from "@kitsunekode/sweep-core/guardrails";
import {
  scanToPlanViaRust,
  isRustEngineAvailable,
  type EngineBackend,
} from "@kitsunekode/sweep-core/rust-engine";

export function applyNoColor(color: boolean | undefined): void {
  if (!color) {
    process.env.NO_COLOR = "1";
  }
}

export function resolveScanConfig(targetDir: string, opts: CliOptions): SweepConfig {
  const patterns = opts.pattern ?? [];
  const ignore = opts.ignore ?? [];

  for (const pattern of patterns) assertSafePattern(pattern);
  for (const pattern of ignore) assertSafePattern(pattern);

  const cliOverrides: Partial<SweepConfig> = {
    depth: opts.depth,
    ...(patterns.length > 0 ? { patterns } : {}),
    ...(ignore.length > 0 ? { ignore } : {}),
  };

  return loadConfig(targetDir, opts.config, cliOverrides);
}

export function resolveEngineBackend(opts: Pick<CliOptions, "engine">): EngineBackend {
  if (opts.engine === "js") return "js";
  if (opts.engine === "rust") return "rust";
  return isRustEngineAvailable() ? "rust" : "js";
}

export function runScanToPlan(
  targetDir: string,
  config: SweepConfig,
  options: ScanToPlanOptions & { engine?: EngineBackend } = {},
): { result: ScanResult; plan: ScanPlan } {
  if (options.engine === "rust") {
    const plan = scanToPlanViaRust(targetDir);
    return {
      plan,
      result: scanResultFromPlan(plan),
    };
  }

  return scanToPlan(targetDir, config, options);
}

function scanResultFromPlan(plan: ScanPlan): ScanResult {
  return {
    entries: plan.candidates.map((candidate) => ({
      path: candidate.path,
      name: candidate.name,
      estimatedBytes: candidate.estimatedBytes,
      isSymlink: candidate.isSymlink,
      entryType: candidate.entryType,
    })),
    estimatedTotalBytes: plan.summary.estimatedTotalBytes,
    scannedDirs: plan.summary.scannedDirs,
    exact: plan.summary.exact,
  };
}

export function resolveSelectionPolicy(
  opts: Pick<CliOptions, "includeDangerous" | "select">,
): SelectionPolicy {
  const mode = isSelectionMode(opts.select) ? opts.select : "default";
  return {
    mode,
    includeDangerous: opts.includeDangerous ?? false,
  };
}

function isSelectionMode(value: string | undefined): value is SelectionMode {
  return value === "default" || value === "safe" || value === "all" || value === "none";
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Show a [y/N] prompt. Default is NO (empty input → false). */
export function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolvePromise(normalized === "y" || normalized === "yes");
    });
  });
}
