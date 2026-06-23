import { Command } from "commander";
import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { handleApply } from "./handlers/apply.js";
import { handleClean } from "./handlers/clean.js";
import { handleDoctor } from "./handlers/doctor.js";
import { handleInit } from "./handlers/init.js";
import { handlePlan } from "./handlers/plan.js";
import { handleScan } from "./handlers/scan.js";
import { handleUi } from "./handlers/ui.js";

// Injected at build time by apps/cli/scripts/build.ts via Bun.build define.
// Falls back to package.json version for `bun run dev`.
declare const __SWEEP_VERSION__: string | undefined;
export const VERSION = typeof __SWEEP_VERSION__ !== "undefined" ? __SWEEP_VERSION__ : "0.0.0-dev";

const HELP_EXAMPLES = `
Examples:
  $ sweep                         Clean current directory (prompts before delete)
  $ sweep clean ~/projects/app    Same as default — explicit clean command
  $ sweep --dry-run               Preview deletions without changes
  $ sweep init                    Scaffold .sweeprc in the current directory
  $ sweep scan . --json           Emit a machine-readable cleanup plan
  $ sweep ui .                    Interactive TUI for monorepo review
  $ sweep doctor --json           Environment + config + dry-scan report
  $ sweep apply --plan plan.json --yes
`;

function addOutputOptions<T extends Command>(command: T): T {
  return command
    .option("--json", "Emit structured JSON output", false)
    .option("-q, --quiet", "Suppress non-essential output", false)
    .option("--verbose", "Show per-candidate scan progress", false);
}

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
      "--disabled-pattern <pattern>",
      "Disable a default pattern for this run, repeatable",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option(
      "--depth <n>",
      "Max recursion depth (-1 = unlimited)",
      (v) => Number.parseInt(v, 10),
      -1,
    )
    .option("--select <mode>", "Default selection policy: default, safe, all, none", "default")
    .option("--include-dangerous", "Include dangerous candidates in selection", false)
    .option("--config <path>", "Explicit config file path")
    .option("--engine <backend>", "Scan engine: js (default), rust, or auto", "js")
    .option("--no-color", "Disable color output");
}

function addCleanAction(command: Command): Command {
  return command
    .argument("[path]", "Directory to sweep", ".")
    .option("-n, --dry-run", "Preview deletions without making changes", false)
    .option("--force-large", "Allow deletion exceeding maxSizeGB threshold", false)
    .action(function (this: Command, pathArg: string) {
      void handleClean(pathArg, this.optsWithGlobals<CliOptions>());
    });
}

export function makeProgram(): Command {
  const program = new Command();

  program
    .name("sweep")
    .description("Safe, fast artifact cleanup for any project tree")
    .version(VERSION, "-V, --version")
    .addHelpText("after", HELP_EXAMPLES);

  addScanOptions(program);
  addOutputOptions(program);
  program.option("-y, --yes", "Skip confirmation prompt", false);

  addCleanAction(program);

  addCleanAction(
    program
      .command("clean")
      .description("Clean artifacts with confirmation (alias for default action)"),
  );

  program
    .command("scan")
    .description("Scan a directory for cleanup candidates")
    .argument("[path]", "Directory to scan", ".")
    .option("--json-stream", "Emit NDJSON scan lifecycle events", false)
    .action(function (this: Command, pathArg: string) {
      void handleScan(
        pathArg,
        this.optsWithGlobals<CliOptions & { json?: boolean; jsonStream?: boolean }>(),
      );
    });

  program
    .command("plan")
    .description("Scan and emit a saved plan document")
    .argument("[path]", "Directory to scan", ".")
    .action(function (this: Command, pathArg: string) {
      void handlePlan(pathArg, this.optsWithGlobals<CliOptions>());
    });

  program
    .command("ui")
    .description("Interactive cleanup UI")
    .argument("[path]", "Directory to scan interactively", ".")
    .action(function (this: Command, pathArg: string) {
      void handleUi(pathArg, this.optsWithGlobals<CliOptions>());
    });

  program
    .command("apply")
    .description("Apply a saved scan plan")
    .requiredOption("--plan <path>", "Path to a saved scan plan")
    .option("--engine <backend>", "Apply engine: js (default), rust, or auto", "js")
    .option("--json", "Emit JSON apply results", false)
    .action(function (this: Command) {
      const opts = this.optsWithGlobals<{
        plan: string;
        yes: boolean;
        json?: boolean;
        color: boolean;
        engine?: import("@kitsunekode/sweep-protocol").EngineBackend;
      }>();
      void handleApply(opts);
    });

  program
    .command("init")
    .description("Scaffold a starter .sweeprc in the target directory")
    .argument("[path]", "Directory to initialize", ".")
    .option("-f, --force", "Overwrite an existing .sweeprc", false)
    .action(function (this: Command, pathArg: string) {
      const opts = this.optsWithGlobals<{ force?: boolean; color: boolean }>();
      void handleInit({ path: pathArg, force: opts.force ?? false, color: opts.color });
    });

  program
    .command("doctor")
    .description("Check sweep environment, config, and dry-scan preview")
    .argument("[path]", "Directory to inspect", ".")
    .action(function (this: Command, pathArg: string) {
      const opts = this.optsWithGlobals<{
        color: boolean;
        json?: boolean;
        quiet?: boolean;
        verbose?: boolean;
      }>();
      void handleDoctor({ path: pathArg, ...opts });
    });

  return program;
}
