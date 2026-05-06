import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Command } from "commander";
import type {
  ApplyReport,
  CliOptions,
  ScanEvent,
  ScanPlan,
  SweepConfig,
} from "../../protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../protocol/src/index.js";
import { clean } from "../../core/src/cleaner.js";
import { loadConfig } from "../../core/src/config.js";
import { applyPlan as executePlan, scanToPlan } from "../../core/src/engine.js";
import {
  GuardrailError,
  assertSafeCwd,
  assertSafePattern,
  assertSizeLimit,
} from "../../core/src/guardrails.js";
import { toCandidate } from "../../core/src/planner.js";
import { scan } from "../../core/src/scanner.js";
import {
  createSpinner,
  formatBytes,
  printAborted,
  printBanner,
  printCleanResult,
  printDryRunNotice,
  printError,
  printScanSummary,
} from "./display.js";

// ─── CLI definition ───────────────────────────────────────────────────────────

// Injected at build time by scripts/build.ts via Bun.build define.
// Falls back to package.json version for `bun run dev`.
declare const __SWEEP_VERSION__: string | undefined;
const VERSION = typeof __SWEEP_VERSION__ !== "undefined" ? __SWEEP_VERSION__ : "0.0.0-dev";

const program = new Command();

program
  .name("sweep")
  .description("Safe, fast artifact cleanup for any project tree")
  .version(VERSION, "-V, --version");

addScanOptions(
  program
    .argument("[path]", "Directory to sweep", ".")
    .option("-n, --dry-run", "Preview deletions without making changes", false),
)
  .option("-y, --yes", "Skip confirmation prompt", false)
  .option("--force-large", "Allow deletion exceeding maxSizeGB threshold", false)
  .action(async (pathArg: string, opts: CliOptions) => {
    await handleLegacyClean(pathArg, opts);
  });

addScanOptions(program.command("scan").argument("[path]", "Directory to scan", "."))
  .option("--json", "Emit a plan-shaped JSON document", false)
  .option("--json-stream", "Emit NDJSON scan lifecycle events", false)
  .action(async (pathArg: string, opts: CliOptions & { json?: boolean; jsonStream?: boolean }) => {
    await handleScan(pathArg, opts);
  });

program
  .command("apply")
  .description("Apply a saved scan plan")
  .requiredOption("--plan <path>", "Path to a saved scan plan")
  .option("-y, --yes", "Skip confirmation prompt", false)
  .option("--json", "Emit JSON apply results", false)
  .option("--no-color", "Disable color output")
  .action(async (opts: { plan: string; yes: boolean; json?: boolean; color: boolean }) => {
    await handleApply(opts);
  });

program.parse();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function addScanOptions<T extends Command>(command: T): T {
  return command
    .option(
      "-p, --pattern <pattern>",
      "Add extra pattern, repeatable: -p .output -p .cache",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option(
      "-i, --ignore <pattern>",
      "Add ignore pattern, repeatable",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option(
      "--depth <n>",
      "Max recursion depth (-1 = unlimited)",
      (v) => Number.parseInt(v, 10),
      -1,
    )
    .option("--config <path>", "Explicit config file path")
    .option("--no-color", "Disable color output");
}

async function handleLegacyClean(pathArg: string, opts: CliOptions): Promise<void> {
  if (!opts.color) process.env.NO_COLOR = "1";

  const targetDir = resolve(pathArg);

  try {
    assertSafeCwd(targetDir);

    if (opts.forceLarge && !opts.yes) {
      throw new GuardrailError(
        "--force-large requires --yes. Large deletes must be non-interactive.",
      );
    }

    const config = resolveScanConfig(targetDir, opts);

    printBanner();

    const spinner = createSpinner(opts.dryRun ? "Scanning (exact sizes)..." : "Scanning...");
    const result = scan(targetDir, config, opts.dryRun);
    spinner.stop();

    printScanSummary(result, targetDir);

    if (result.entries.length === 0) {
      process.exit(0);
    }

    assertSizeLimit(result.estimatedTotalBytes, config.maxSizeGB, opts.forceLarge);

    if (opts.dryRun) {
      printDryRunNotice();
      process.exit(0);
    }

    if (!opts.yes) {
      const confirmed = await promptConfirm(
        `Delete ${result.entries.length} items (~${formatBytes(result.estimatedTotalBytes)})?`,
      );
      if (!confirmed) {
        printAborted();
        process.exit(1);
      }
    }

    const cleanResult = await clean(result.entries);
    printCleanResult(cleanResult);

    process.exit(cleanResult.failedPaths.length > 0 ? 4 : 0);
  } catch (err) {
    handleFatalError(err);
  }
}

async function handleScan(
  pathArg: string,
  opts: CliOptions & { json?: boolean; jsonStream?: boolean },
): Promise<void> {
  if (!opts.color) process.env.NO_COLOR = "1";

  const targetDir = resolve(pathArg);

  try {
    assertSafeCwd(targetDir);
    const config = resolveScanConfig(targetDir, opts);

    if (opts.jsonStream) {
      const startedEvent: ScanEvent = { type: "scan_started", targetDir };
      writeJsonLine(startedEvent);

      const { result } = scanToPlan(targetDir, config, {
        exact: false,
        onEntry: (entry) => {
          const candidate = toCandidate(entry);
          writeJsonLine({ type: "candidate_found", candidate } satisfies ScanEvent);
        },
      });

      for (const entry of result.entries) {
        const candidate = toCandidate(entry);
        writeJsonLine({ type: "candidate_updated", candidate } satisfies ScanEvent);
      }

      writeJsonLine({
        type: "scan_completed",
        summary: {
          candidateCount: result.entries.length,
          estimatedTotalBytes: result.estimatedTotalBytes,
          scannedDirs: result.scannedDirs,
        },
      } satisfies ScanEvent);
      process.exit(0);
    }

    const spinner = opts.json ? null : createSpinner("Scanning...");
    const { result, plan } = scanToPlan(targetDir, config);
    spinner?.stop();

    if (opts.json) {
      writeJson(plan);
      process.exit(0);
    }

    printBanner();
    printScanSummary(result, targetDir);
    process.exit(0);
  } catch (err) {
    handleFatalError(err);
  }
}

async function handleApply(opts: {
  plan: string;
  yes: boolean;
  json?: boolean;
  color: boolean;
}): Promise<void> {
  if (!opts.color) process.env.NO_COLOR = "1";

  try {
    const plan = loadPlan(opts.plan);
    const skipPrompt = opts.yes || process.argv.includes("--yes") || process.argv.includes("-y");
    const selectedCount = plan.selectedCandidateIds.length;

    if (selectedCount === 0) {
      const report: ApplyReport = {
        protocolVersion: PROTOCOL_VERSION,
        targetDir: plan.targetDir,
        selectedCandidateIds: [],
        deletedCount: 0,
        failedCount: 0,
        totalBytesFreed: 0,
        failedPaths: [],
      };
      if (opts.json) {
        writeJson(report);
      } else {
        console.log("Nothing selected to apply.");
      }
      process.exit(0);
    }

    if (!skipPrompt) {
      const totalBytes = plan.candidates
        .filter((candidate) => plan.selectedCandidateIds.includes(candidate.id))
        .reduce((sum, candidate) => sum + candidate.estimatedBytes, 0);
      const confirmed = await promptConfirm(
        `Apply plan with ${selectedCount} items (${formatBytes(totalBytes)})?`,
      );
      if (!confirmed) {
        printAborted();
        process.exit(1);
      }
    }

    const { report, cleanResult } = await executePlan(plan);

    if (opts.json) {
      writeJson(report);
    } else {
      printCleanResult({
        ...cleanResult,
        failedPaths: report.failedPaths,
      });
    }

    process.exit(report.failedCount > 0 ? 4 : 0);
  } catch (err) {
    handleFatalError(err);
  }
}

function resolveScanConfig(targetDir: string, opts: CliOptions): SweepConfig {
  const patterns = resolveRepeatableOption(opts.pattern, ["-p", "--pattern"]);
  const ignore = resolveRepeatableOption(opts.ignore, ["-i", "--ignore"]);

  for (const pattern of patterns) assertSafePattern(pattern);
  for (const pattern of ignore) assertSafePattern(pattern);

  const cliOverrides: Partial<SweepConfig> = {
    depth: opts.depth,
    ...(patterns.length > 0 ? { patterns } : {}),
    ...(ignore.length > 0 ? { ignore } : {}),
  };

  return loadConfig(targetDir, opts.config, cliOverrides);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function loadPlan(planPath: string): ScanPlan {
  if (!existsSync(planPath)) {
    throw new GuardrailError(`Plan file not found: ${planPath}`, 4);
  }

  const raw = readFileSync(planPath, "utf8");
  return JSON.parse(raw) as ScanPlan;
}

function handleFatalError(err: unknown): never {
  if (err instanceof GuardrailError) {
    printError(err.message);
    process.exit(err.code);
  }
  if (err instanceof SyntaxError) {
    printError(`Config parse error: ${err.message}`);
    process.exit(3);
  }
  printError(err instanceof Error ? err.message : String(err));
  process.exit(4);
}

function resolveRepeatableOption(current: string[] | undefined, flags: string[]): string[] {
  if (current && current.length > 0) {
    return current;
  }

  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    const token = process.argv[i];
    if (!token || !flags.includes(token)) continue;
    const next = process.argv[i + 1];
    if (next && !next.startsWith("-")) {
      values.push(next);
    }
  }
  return values;
}

/** Show a [y/N] prompt. Default is NO (empty input → false). */
function promptConfirm(question: string): Promise<boolean> {
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
