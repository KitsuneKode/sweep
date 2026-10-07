import { readApplyLockStatus } from "@kitsunekode/sweep-core/apply-session";
import { readFilesystemIdentity } from "@kitsunekode/sweep-core/filesystem-identity";
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
import type { SweepConfig } from "@kitsunekode/sweep-protocol";
import { formatBytes, sanitizeTerminalText } from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  isOpenTuiAvailable,
  resolveScanConfig,
  resolveEngineBackend,
  runScanToPlan,
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
  let rustSafetyOk = false;
  if (rustOk) {
    try {
      const capabilities = JSON.parse(
        execFileSync(rustBinary, ["--capabilities"], {
          encoding: "utf8",
          timeout: 1000,
          killSignal: "SIGKILL",
          maxBuffer: 4096,
        }),
      );
      rustSafetyOk = capabilities?.applyControl === true && capabilities?.planIdentity === true;
    } catch {
      /* Report an incompatible or broken engine rather than certifying it. */
    }
  }
  const engine = resolveEngineBackend(opts);
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
      const { result } = await runScanToPlan(targetDir, config, {
        engine,
        exact: false,
        resourceProfile: opts.resourceProfile,
      });
      scanDetail =
        `${engine} · ${result.entries.length} candidates · ${formatBytes(result.estimatedTotalBytes)} · ` +
        `${result.scannedDirs} dirs` +
        (result.skippedDirs > 0 ? ` (${result.skippedDirs} skipped)` : "");
    } catch (error) {
      scanOk = false;
      scanDetail = error instanceof Error ? error.message : String(error);
    }
  }

  const lock = readApplyLockStatus();
  const rootIdentity = readFilesystemIdentity(targetDir);
  return [
    {
      name: "apply_lock",
      ok: !lock.held,
      detail: !lock.held
        ? "available"
        : `${lock.lockPath} · ${lock.owner ? `host PID ${lock.owner.pid}: ${lock.processStatus}; journal ${lock.owner.journalPath}` : (lock.detail ?? "owner unknown")}. Inspect recovery before manual cleanup; a child may outlive the host.`,
    },
    { name: "protocol", ok: true, detail: PROTOCOL_VERSION },
    {
      name: "filesystem_identity",
      ok: rootIdentity !== undefined,
      detail: rootIdentity
        ? "stable root identifier available; descendants are checked individually at apply"
        : "root identifier unavailable; apply is disabled, and rescanning cannot provide identity safety",
    },
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

    {
      name: "opentui",
      ok: openTuiOk,
      detail: openTuiOk ? "available" : "install @opentui/core for sweep ui",
    },
    { name: "rust_engine", ok: rustOk, detail: rustOk ? rustBinary : "not found" },
    {
      name: "rust_apply_safety",
      ok: rustSafetyOk,
      detail: rustSafetyOk
        ? "controlled cancellation and plan identity supported"
        : "missing or incompatible native capabilities",
    },
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
    handleFatalError(err, { json: opts.json });
  }
}
