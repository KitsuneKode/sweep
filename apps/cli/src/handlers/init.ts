import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CliOptions, ScanCandidate } from "@kitsunekode/sweep-protocol";
import { PATTERN_CATALOG } from "@kitsunekode/sweep-core/catalog";
import { DEFAULT_CONFIG, writeInitSweeprc } from "@kitsunekode/sweep-core/config";
import { globMatch } from "@kitsunekode/sweep-core/glob-match";
import { assertSafeCwd, assertTargetDirectory } from "@kitsunekode/sweep-core/guardrails";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  formatBytes,
  printInitNextSteps,
  printInitReport,
  sanitizeTerminalText,
  type InitFinding,
} from "@kitsunekode/sweep-display";
import {
  applyNoColor,
  promptConfirm,
  resolveEngineBackend,
  resolveTargetPath,
  runScanToPlan,
  warnIgnoredOptions,
} from "./shared.js";

export type InitHandlerOptions = CliOptions & {
  path?: string;
  force: boolean;
};

/**
 * `sweep init` looks before it writes: a read-only scan with every catalog
 * pattern on shows what this tree actually holds. Built-in matches need no
 * config; opt-in names (dist, build, .venv, ...) are each a question, asked
 * only in a terminal. The file records those answers and nothing else.
 */
export async function handleInit(opts: InitHandlerOptions): Promise<void> {
  applyNoColor(opts.color);
  warnIgnoredOptions(opts, "init", { except: ["--dry-run", "--yes", "--engine"] });

  const targetDir = resolveTargetPath(opts.path ?? ".");
  const configPath = resolve(targetDir, ".sweeprc");

  try {
    assertSafeCwd(targetDir);
    assertTargetDirectory(targetDir);
    // Refuse before scanning: nobody should wait to be told no.
    if (!opts.force && !opts.dryRun && existsSync(configPath)) {
      console.error(
        `error: ${sanitizeTerminalText(configPath)} already exists (use --force to overwrite)`,
      );
      exitWith(EXIT.GUARDRAIL);
    }

    const { plan } = await runScanToPlan(
      targetDir,
      { ...DEFAULT_CONFIG, patterns: PATTERN_CATALOG.map((entry) => entry.pattern) },
      { engine: resolveEngineBackend({ engine: opts.engine ?? "auto" }) },
    );

    const findings = (byDefault: boolean): InitFinding[] =>
      PATTERN_CATALOG.filter((entry) => entry.byDefault === byDefault)
        .map((entry) => {
          const matches = plan.candidates.filter(
            (candidate: ScanCandidate) =>
              candidate.riskTier !== "blocked" && globMatch(entry.pattern, candidate.name),
          );
          return {
            pattern: entry.pattern,
            note: entry.note,
            count: matches.length,
            bytes: matches.reduce((sum, candidate) => sum + candidate.estimatedBytes, 0),
          };
        })
        .filter((finding) => finding.count > 0)
        .sort((a, b) => b.bytes - a.bytes);

    const optIns = findings(false);
    printInitReport({
      targetDir,
      defaults: findings(true),
      optIns,
      blocked: plan.candidates.filter((candidate) => candidate.riskTier === "blocked").length,
    });

    const interactive = Boolean(process.stdin.isTTY) && !opts.yes && !opts.dryRun;
    const patterns: string[] = [];
    if (interactive) {
      for (const finding of optIns) {
        if (
          await promptConfirm(
            ` Also review ${finding.pattern} (${finding.count}, ~${formatBytes(finding.bytes)})?`,
          )
        ) {
          patterns.push(finding.pattern);
        }
      }
      if (optIns.length > 0) console.log("");
    } else if (optIns.length > 0) {
      console.log(
        ` Opt-in names left off. Add any to "patterns" later, or run init in a terminal to choose.\n`,
      );
    }

    const contents = { patterns, ignore: [], maxSizeGB: null };
    if (opts.dryRun) {
      console.log(JSON.stringify(contents, null, 2));
      printInitNextSteps(configPath, false);
      exitWith(EXIT.OK);
    }
    const result = writeInitSweeprc(configPath, opts.force, contents);
    if (result === "exists") {
      console.error(
        `error: ${sanitizeTerminalText(configPath)} already exists (use --force to overwrite)`,
      );
      exitWith(EXIT.GUARDRAIL);
    }
    printInitNextSteps(configPath, true);
    exitWith(EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
