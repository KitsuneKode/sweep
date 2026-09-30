import { statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { PROTOCOL_VERSION } from "@kitsunekode/sweep-protocol";
import { findProjectConfigPath, validateProjectConfigFile } from "@kitsunekode/sweep-core/config";
import { assertSafeCwd } from "@kitsunekode/sweep-core/guardrails";
import {
  isRustEngineAvailable,
  resolveRustEngineBinary,
} from "@kitsunekode/sweep-core/rust-engine";
import { scan } from "@kitsunekode/sweep-core/scanner";
import type { SweepConfig } from "@kitsunekode/sweep-protocol";
import { formatBytes, sanitizeTerminalText } from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  isOpenTuiAvailable,
  resolveScanConfig,
  warnIgnoredOptions,
  writeJson,
} from "./shared.js";

export type DoctorHandlerOptions = CliOptions & {
  path?: string;
  json?: boolean;
};

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

function duAvailable(): boolean {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return false;
  }
  try {
    execFileSync("du", ["-sk", "."], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function targetIsDirectory(targetDir: string): boolean {
  try {
    return statSync(targetDir).isDirectory();
  } catch {
    return false;
  }
}

export async function collectDoctorChecks(
  targetDir: string,
  opts: CliOptions & { trash?: boolean },
): Promise<DoctorCheck[]> {
  // Report the config file loadConfig would actually find - ancestors count.
  const configPath = findProjectConfigPath(targetDir);
  const rustBinary = resolveRustEngineBinary();
  const rustOk = isRustEngineAvailable();
  const duOk = duAvailable();
  const openTuiOk = isOpenTuiAvailable();
  const hasConfigFile = configPath !== null;
  const configValidity = hasConfigFile
    ? validateProjectConfigFile(configPath, targetDir)
    : { ok: true as const, path: configPath ?? "" };

  // The dry scan runs the config a real run would use - CLI flags included -
  // so doctor's preview matches `sweep <same flags>` behavior.
  let config: SweepConfig | null = null;
  let configLoadError: string | undefined;
  try {
    config = resolveScanConfig(targetDir, opts);
  } catch (error) {
    configLoadError = error instanceof Error ? error.message : String(error);
  }

  let scanOk = true;
  let scanDetail = "not run";
  if (config === null) {
    scanOk = false;
    scanDetail = `skipped (config error: ${configLoadError})`;
  } else {
    try {
      const result = await scan(targetDir, config, false);
      scanDetail =
        `${result.entries.length} candidates · ${formatBytes(result.estimatedTotalBytes)} · ` +
        `${result.scannedDirs} dirs` +
        (result.skippedDirs > 0 ? ` (${result.skippedDirs} skipped)` : "");
    } catch (error) {
      scanOk = false;
      scanDetail = error instanceof Error ? error.message : String(error);
    }
  }

  return [
    { name: "protocol", ok: true, detail: PROTOCOL_VERSION },
    {
      name: "target",
      ok: targetIsDirectory(targetDir),
      detail: targetIsDirectory(targetDir)
        ? targetDir
        : `${targetDir} (missing or not a directory)`,
    },
    {
      name: "config",
      ok: configLoadError === undefined && configValidity.ok,
      detail:
        configLoadError ??
        (hasConfigFile
          ? configValidity.ok
            ? configPath!
            : configValidity.detail
          : "defaults (no .sweeprc)"),
    },
    {
      name: "patterns",
      ok: config !== null && config.patterns.length > 0,
      detail: config === null ? "config error" : String(config.patterns.length),
    },
    {
      name: "disabled_patterns",
      ok: true,
      detail: String(config?.disabledPatterns?.length ?? 0),
    },
    { name: "du", ok: duOk, detail: duOk ? "available" : "walk fallback" },
    {
      name: "opentui",
      ok: openTuiOk,
      detail: openTuiOk ? "available" : "install @opentui/core for sweep ui",
    },
    { name: "rust_engine", ok: rustOk, detail: rustOk ? rustBinary : "not found" },
    { name: "dry_scan", ok: scanOk, detail: scanDetail },
  ];
}

export async function handleDoctor(opts: DoctorHandlerOptions): Promise<void> {
  applyNoColor(opts.color);
  // Doctor scans (dry) and honors the output trio - apply-only flags warn.
  warnIgnoredOptions(opts, "doctor", {
    scans: true,
    except: ["--json", "--quiet", "--verbose"],
  });

  const targetDir = resolve(opts.path ?? ".");

  try {
    assertSafeCwd(targetDir);

    const checks = await collectDoctorChecks(targetDir, opts);
    const hasWarnings = checks.some((check) => !check.ok);

    if (opts.json) {
      writeJson({
        protocolVersion: PROTOCOL_VERSION,
        targetDir,
        checks: checks.map((check) => ({
          name: check.name,
          status: check.ok ? "ok" : "warn",
          detail: check.detail,
        })),
        hasWarnings,
      });
      exitWith(hasWarnings ? EXIT.WARN : EXIT.OK);
    }

    const quiet = opts.quiet ?? false;
    const verbose = opts.verbose ?? false;

    for (const check of checks) {
      if (quiet && check.ok && !verbose) continue;

      const status = check.ok ? "ok" : "warn";
      console.log(`${status}\t${check.name}\t${sanitizeTerminalText(check.detail)}`);
    }

    exitWith(hasWarnings ? EXIT.WARN : EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
