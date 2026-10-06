import { Command, InvalidArgumentError, Option } from "commander";
import {
  PROTOCOL_VERSION,
  SCAN_PLAN_SCHEMA,
  SCAN_EVENT_SCHEMA,
  APPLY_REPORT_SCHEMA,
  PROTOCOL_SHARED_SCHEMA,
} from "@kitsunekode/sweep-protocol";
import { writeJson, drainStdout } from "./handlers/shared.js";
import { EXIT, exitWith, handleFatalError } from "./errors.js";
import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { handleApply } from "./handlers/apply.js";
import { handleClean } from "./handlers/clean.js";
import { handleCompletions } from "./handlers/completions.js";
import { handleDoctor } from "./handlers/doctor.js";
import { handleInit } from "./handlers/init.js";
import { handleInspect } from "./handlers/inspect.js";
import { handlePlan } from "./handlers/plan.js";
import { handleScan } from "./handlers/scan.js";
import { handleStats } from "./handlers/stats.js";
import { handleRecover } from "./handlers/recover.js";
import { handleUi } from "./handlers/ui.js";

// Injected at build time by apps/cli/scripts/build.ts via Bun.build define.
// Falls back to package.json version for `bun run dev`.
declare const __SWEEP_VERSION__: string | undefined;
export const VERSION = typeof __SWEEP_VERSION__ !== "undefined" ? __SWEEP_VERSION__ : "0.0.0-dev";

const HELP_EXAMPLES = `
Examples:
  $ sweep                         Clean current directory (prompts before delete)
  $ sweep clean ~/projects/app    Same as default, explicit clean command
  $ sweep --dry-run               Preview deletions without changes
  $ sweep --trash                 Move candidates to .sweep-trash-<ts>/ (reversible)
  $ sweep init                    Scaffold .sweeprc in the current directory
  $ sweep scan . --json           Emit a machine-readable cleanup plan
  $ sweep ui .                    Interactive TUI for monorepo review
  $ sweep doctor --json           Environment + config + dry-scan report
  $ sweep apply --plan plan.json --yes
  $ sweep inspect --plan plan.json
  $ sweep stats                   Show total reclaimed space
`;

function addOutputOptions<T extends Command>(command: T): T {
  return command
    .option("--json", "Emit structured JSON output", false)
    .option("-q, --quiet", "Suppress non-essential output", false)
    .option("--verbose", "Show per-candidate scan progress", false);
}

function addScanOptions<T extends Command>(command: T): T {
  return (
    command
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
      .option("--depth <n>", "Max recursion depth (-1 = unlimited)", (v: string) => {
        // Strict digits only - parseInt("5x") -> 5 would silently mangle intent.
        if (!/^-?\d+$/.test(v)) {
          throw new InvalidArgumentError(`expected an integer, got "${v}"`);
        }
        return Number.parseInt(v, 10);
      })
      // .choices makes an unknown value a usage error - a typo like
      // `--select safe` mistyped must not silently select MORE (or less) than
      // asked.
      .addOption(
        new Option("--select <mode>", "Default selection policy")
          .choices(["default", "safe", "all", "none"])
          .default("default"),
      )
      .option("--include-dangerous", "Include dangerous candidates in selection", false)
      .option("--config <path>", "Explicit config file path")
      .addOption(
        new Option(
          "--engine <backend>",
          "Scan engine: auto (default - rust when its binary is available), rust, or js",
        )
          .choices(["auto", "rust", "js"])
          .default("auto"),
      )
      .addOption(
        new Option(
          "--resource-profile <profile>",
          "Scan resource allowance (logical memory, not RSS)",
        )
          .choices(["balanced", "low-memory"])
          .default("balanced"),
      )
      .option(
        "--cold",
        "Cold-start run: refresh the engine probe and drop OS page cache when permitted (dev)",
        false,
      )
      .option("--no-color", "Disable color output")
  );
}

function addCleanAction(command: Command): Command {
  return command
    .argument("[path]", "Directory to sweep", ".")
    .option("-n, --dry-run", "Preview deletions without making changes", false)
    .option("--trash", "Move candidates to .sweep-trash-<ts>/ instead of deleting", false)
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

  // The flag is a bridge: core read sites (engine probe, page-cache drop)
  // check SWEEP_COLD so a TUI rescan honors it without plumbing through
  // every layer.
  program.hook("preAction", (thisCommand) => {
    if (thisCommand.opts<{ cold?: boolean }>().cold === true) {
      process.env.SWEEP_COLD = "1";
    }
  });

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
    .option("--trash", "Move candidates to .sweep-trash-<ts>/ instead of deleting", false)
    .action(function (this: Command, pathArg: string) {
      void handleUi(pathArg, this.optsWithGlobals<CliOptions>());
    });

  program
    .command("apply")
    .description("Apply a saved scan plan")
    .requiredOption("--plan <path>", "Path to a saved scan plan")
    .addOption(
      new Option(
        "--engine <backend>",
        "Apply engine: auto (default - rust when its binary is available), rust, or js",
      )
        .choices(["auto", "rust", "js"])
        .default("auto"),
    )
    .option("-n, --dry-run", "Preview the plan's deletions without making changes", false)
    .option("--trash", "Move candidates to .sweep-trash-<ts>/ instead of deleting", false)
    .option("--force-large", "Allow deletion exceeding maxSizeGB threshold", false)
    .option("--json", "Emit JSON apply results", false)
    .action(function (this: Command) {
      const opts = this.optsWithGlobals<
        CliOptions & {
          plan: string;
          trash?: boolean;
          json?: boolean;
        }
      >();
      void handleApply(opts);
    });

  program
    .command("schema")
    .description("Export versioned plan, event and report JSON Schemas without scanning")
    .action(async () => {
      try {
        writeJson({
          protocolVersion: PROTOCOL_VERSION,
          schemas: {
            scanPlan: SCAN_PLAN_SCHEMA,
            scanEvent: SCAN_EVENT_SCHEMA,
            applyReport: APPLY_REPORT_SCHEMA,
            shared: PROTOCOL_SHARED_SCHEMA,
          },
        });
        await drainStdout();
        exitWith(EXIT.OK);
      } catch (error) {
        handleFatalError(error);
      }
    });

  program
    .command("recover")
    .description("Inspect an apply journal without retrying or restoring operations")
    .requiredOption("--journal <path>", "Private apply journal to inspect")
    .option("--json", "Emit JSON recovery observations", false)
    .action(function (this: Command) {
      void handleRecover(this.optsWithGlobals<{ journal: string; json?: boolean }>());
    });

  program
    .command("inspect")
    .description("Inspect a saved scan plan without applying it")
    .requiredOption("--plan <path>", "Path to a saved scan plan")
    .option("--json", "Emit the plan summary as JSON", false)
    .action(function (this: Command) {
      const opts = this.optsWithGlobals<
        CliOptions & {
          plan: string;
          json?: boolean;
        }
      >();
      void handleInspect(opts);
    });

  program
    .command("stats")
    .description("Show cleanup history and total reclaimed space")
    .option("--json", "Emit history as JSON", false)
    .action(function (this: Command) {
      const opts = this.optsWithGlobals<CliOptions & { json?: boolean }>();
      void handleStats(opts);
    });

  program
    .command("completions")
    .description("Print shell completion script (bash, zsh, or fish)")
    .argument("<shell>", "Shell to generate completions for: bash, zsh, or fish")
    .action(function (this: Command, shell: string) {
      const opts = this.optsWithGlobals<CliOptions>();
      void handleCompletions(shell, opts, this.parent ?? this);
    });

  program
    .command("init")
    .description("Scaffold a starter .sweeprc in the target directory")
    .argument("[path]", "Directory to initialize", ".")
    .option("-f, --force", "Overwrite an existing .sweeprc", false)
    .action(function (this: Command, pathArg: string) {
      const opts = this.optsWithGlobals<CliOptions & { force?: boolean }>();
      void handleInit({ ...opts, path: pathArg, force: opts.force ?? false });
    });

  program
    .command("doctor")
    .description("Check sweep environment, config, and dry-scan preview")
    .argument("[path]", "Directory to inspect", ".")
    .action(function (this: Command, pathArg: string) {
      const opts = this.optsWithGlobals<CliOptions & { json?: boolean }>();
      void handleDoctor({ ...opts, path: pathArg });
    });

  return program;
}
