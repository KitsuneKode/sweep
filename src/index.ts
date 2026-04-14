import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Command } from "commander";
import { clean } from "./cleaner.js";
import { loadConfig } from "./config.js";
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
import { GuardrailError, assertSafeCwd, assertSafePattern, assertSizeLimit } from "./guardrails.js";
import { scan } from "./scanner.js";
import type { CliOptions } from "./types.js";

// ─── CLI definition ───────────────────────────────────────────────────────────

// Injected at build time by scripts/build.ts via Bun.build define.
// Falls back to package.json version for `bun run dev`.
declare const __SWEEP_VERSION__: string | undefined;
const VERSION = typeof __SWEEP_VERSION__ !== "undefined" ? __SWEEP_VERSION__ : "0.0.0-dev";

const program = new Command();

program
  .name("sweep")
  .description("Safe, fast artifact cleanup for any project tree")
  .version(VERSION, "-V, --version")
  .argument("[path]", "Directory to sweep", ".")
  .option("-n, --dry-run", "Preview deletions without making changes", false)
  .option("-y, --yes", "Skip confirmation prompt", false)
  .option("--force-large", "Allow deletion exceeding maxSizeGB threshold", false)
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
  .option("--depth <n>", "Max recursion depth (-1 = unlimited)", (v) => Number.parseInt(v, 10), -1)
  .option("--config <path>", "Explicit config file path")
  .option("--no-color", "Disable color output")
  .action(async (pathArg: string, opts: CliOptions) => {
    // --no-color: env var set here is too late for picocolors (module-level init).
    // The real NO_COLOR injection is prepended to the bundle by scripts/build.ts.
    // This assignment keeps it consistent for any code that reads process.env directly.
    if (!opts.color) process.env.NO_COLOR = "1";

    const targetDir = resolve(pathArg);

    try {
      // ── 1. Guardrails: validate the target directory ──────────────────────
      assertSafeCwd(targetDir);

      // --force-large requires --yes (no interactive bypass for oversized deletes)
      if (opts.forceLarge && !opts.yes) {
        throw new GuardrailError(
          "--force-large requires --yes. Large deletes must be non-interactive.",
        );
      }

      // ── 2. Validate any extra patterns from CLI ───────────────────────────
      for (const p of opts.pattern) assertSafePattern(p);
      for (const p of opts.ignore) assertSafePattern(p);

      // ── 3. Load merged config ─────────────────────────────────────────────
      // Build without undefined values (required by exactOptionalPropertyTypes)
      const cliOverrides: Partial<import("./types.js").SweepConfig> = {
        depth: opts.depth,
        ...(opts.pattern.length > 0 ? { patterns: opts.pattern } : {}),
        ...(opts.ignore.length > 0 ? { ignore: opts.ignore } : {}),
      };
      const config = loadConfig(targetDir, opts.config, cliOverrides);

      printBanner();

      // ── 4. Scan ───────────────────────────────────────────────────────────
      const spinner = createSpinner(opts.dryRun ? "Scanning (exact sizes)..." : "Scanning...");
      const result = scan(targetDir, config, opts.dryRun);
      spinner.stop();

      printScanSummary(result, targetDir);

      if (result.entries.length === 0) {
        process.exit(0);
      }

      // ── 5. Size guardrail ─────────────────────────────────────────────────
      assertSizeLimit(result.estimatedTotalBytes, config.maxSizeGB, opts.forceLarge);

      // ── 6. Dry run: stop before any deletion ──────────────────────────────
      if (opts.dryRun) {
        printDryRunNotice();
        process.exit(0);
      }

      // ── 7. Confirmation prompt (skipped with --yes) ───────────────────────
      if (!opts.yes) {
        const confirmed = await promptConfirm(
          `Delete ${result.entries.length} items (~${formatBytes(result.estimatedTotalBytes)})?`,
        );
        if (!confirmed) {
          printAborted();
          process.exit(1);
        }
      }

      // ── 8. Delete ─────────────────────────────────────────────────────────
      const cleanResult = await clean(result.entries);
      printCleanResult(cleanResult);

      process.exit(cleanResult.failedPaths.length > 0 ? 4 : 0);
    } catch (err) {
      if (err instanceof GuardrailError) {
        printError(err.message);
        process.exit(err.code);
      }
      // Config parse errors
      if (err instanceof SyntaxError) {
        printError(`Config parse error: ${err.message}`);
        process.exit(3);
      }
      printError(err instanceof Error ? err.message : String(err));
      process.exit(4);
    }
  });

program.parse();

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
