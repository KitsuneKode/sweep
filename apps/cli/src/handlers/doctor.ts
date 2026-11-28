import { readApplyLockStatus } from "@kitsunekode/sweep-core/apply-session";
import { readFilesystemIdentity } from "@kitsunekode/sweep-core/filesystem-identity";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { PROTOCOL_VERSION } from "@kitsunekode/sweep-protocol";
import {
  findProjectConfigPath,
  validateProjectConfigFile,
  validateSweepConfigDirectory,
  type ConfigDirReasonKind,
} from "@kitsunekode/sweep-core/config";
import { assertSafeCwd } from "@kitsunekode/sweep-core/guardrails";
import { detectLinuxLibc, type DetectedLinuxLibc } from "@kitsunekode/sweep-core/native-platforms";
import { probeRustEngine, readRustEngineCapabilities } from "@kitsunekode/sweep-core/rust-engine";
import type { SweepConfig } from "@kitsunekode/sweep-protocol";
import { formatBytes, printDoctorReport } from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  drainStdout,
  resolveScanConfig,
  resolveEngineBackend,
  runScanToPlan,
  verifyOpenTuiAvailable,
  warnIgnoredOptions,
  writeJson,
} from "./shared.js";
import { hasRegisteredUiModule } from "./ui.js";

export type DoctorHandlerOptions = CliOptions & {
  path?: string;
  json?: boolean;
};

export type DoctorCheckReasonKind =
  | "lock_held"
  | "identity_unavailable"
  | "target_invalid"
  | "config_invalid"
  | ConfigDirReasonKind
  | "no_patterns"
  | "missing"
  | "version_mismatch"
  | "missing_exports"
  | "load_error"
  | "not_installed"
  | "libc_unknown"
  | "untrusted"
  | "changed"
  | "spawn_error"
  | "probe_failed"
  | "timeout"
  | "engine_unavailable"
  | "capabilities_unsupported"
  | "scan_failed";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  /** Stable machine-readable reason code when a check warns. */
  reasonKind?: DoctorCheckReasonKind;
  /** Concise human-readable reason sentence when a check warns. */
  reason?: string;
};

export interface MissingRustEngineDiagnosis {
  detail: string;
  reasonKind: "not_installed" | "libc_unknown";
  reason: string;
}

export function diagnoseMissingRustEngine(
  platform: string = process.platform,
  linuxLibc: DetectedLinuxLibc = platform === "linux" ? detectLinuxLibc() : "unknown",
  envEnginePath: string | null = process.env.SWEEP_ENGINE_PATH ?? null,
): MissingRustEngineDiagnosis {
  if (!envEnginePath && platform === "linux" && linuxLibc === "unknown") {
    return {
      detail:
        "not found (Linux libc detection was inconclusive; no native engine package selected, falling back to JS — set SWEEP_ENGINE_PATH to override)",
      reasonKind: "libc_unknown",
      reason:
        "Linux libc detection was inconclusive; no native engine package was selected, falling back to JS. Set SWEEP_ENGINE_PATH to override.",
    };
  }
  return {
    detail: "not found",
    reasonKind: "not_installed",
    reason: "Native Rust engine binary was not found.",
  };
}

export function describeMissingRustEngine(
  platform: string = process.platform,
  linuxLibc: DetectedLinuxLibc = platform === "linux" ? detectLinuxLibc() : "unknown",
  envEnginePath: string | null = process.env.SWEEP_ENGINE_PATH ?? null,
): string {
  return diagnoseMissingRustEngine(platform, linuxLibc, envEnginePath).detail;
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
  const explicitConfigPath = opts.config ? resolve(opts.config) : null;
  const configPath = explicitConfigPath ?? findProjectConfigPath(targetDir);
  const rustProbe = probeRustEngine();
  const rustOk = rustProbe.available;
  const rustExecutable = rustProbe.resolvedPath ?? rustProbe.binary;
  let rustSafetyOk = false;
  if (rustOk && rustProbe.resolvedPath) {
    // The same bound, trust-checked engine the probe selected; an incompatible
    // or broken engine is reported rather than certified.
    const capabilities = readRustEngineCapabilities();
    rustSafetyOk = capabilities?.applyControl === true && capabilities?.planIdentity === true;
  }
  const engine = resolveEngineBackend(opts, { warnOnFallback: false });
  const embeddedUi = hasRegisteredUiModule();
  const openTui = embeddedUi ? null : await verifyOpenTuiAvailable();
  const hasConfigFile = configPath !== null;
  const configValidity = hasConfigFile
    ? validateProjectConfigFile(configPath, targetDir, {
        requireOwned: explicitConfigPath === null,
      })
    : { ok: true as const, path: configPath ?? "" };
  const configDirValidity = validateSweepConfigDirectory();

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
  const targetOk = targetIsDirectory(targetDir);
  const configOk = configLoadError === undefined && configValidity.ok;
  const patternsOk = config !== null && config.patterns.length > 0;
  const missingRust =
    !rustOk && rustProbe.reasonKind === "not_installed" ? diagnoseMissingRustEngine() : null;
  return [
    {
      name: "apply_lock",
      ok: !lock.held,
      detail: !lock.held
        ? "available"
        : `${lock.lockPath} · ${lock.owner ? `host PID ${lock.owner.pid}: ${lock.processStatus}; journal ${lock.owner.journalPath}` : (lock.detail ?? "owner unknown")}. Inspect recovery before manual cleanup; a child may outlive the host.`,
      ...(lock.held
        ? {
            reasonKind: "lock_held" as const,
            reason: "Another apply session currently holds the apply lock.",
          }
        : {}),
    },
    { name: "protocol", ok: true, detail: PROTOCOL_VERSION },
    {
      name: "filesystem_identity",
      ok: rootIdentity !== undefined,
      detail: rootIdentity
        ? "stable root identifier available; descendants are checked individually at apply"
        : "root identifier unavailable; apply is disabled, and rescanning cannot provide identity safety",
      ...(rootIdentity === undefined
        ? {
            reasonKind: "identity_unavailable" as const,
            reason: "Filesystem root identity could not be read; apply is disabled.",
          }
        : {}),
    },
    {
      name: "target",
      ok: targetOk,
      detail: targetOk ? targetDir : `${targetDir} (missing or not a directory)`,
      ...(!targetOk
        ? {
            reasonKind: "target_invalid" as const,
            reason: `Target path does not exist or is not a directory: ${targetDir}.`,
          }
        : {}),
    },
    {
      name: "config",
      ok: configOk,
      detail:
        configLoadError ??
        (hasConfigFile
          ? configValidity.ok
            ? configPath!
            : configValidity.detail
          : "defaults (no .sweeprc)"),
      ...(!configOk
        ? {
            reasonKind: "config_invalid" as const,
            reason:
              configLoadError ??
              (!configValidity.ok ? configValidity.detail : "Project configuration is invalid."),
          }
        : {}),
    },
    {
      name: "config_dir",
      ok: configDirValidity.ok,
      detail: configDirValidity.ok
        ? configDirValidity.exists
          ? configDirValidity.path
          : `${configDirValidity.path} (missing; apply creates it with mode 0700)`
        : configDirValidity.detail,
      ...(configDirValidity.ok
        ? {}
        : {
            reasonKind: configDirValidity.reasonKind,
            reason: configDirValidity.detail,
          }),
    },
    {
      name: "patterns",
      ok: patternsOk,
      detail: config === null ? "config error" : String(config.patterns.length),
      ...(!patternsOk
        ? {
            reasonKind: (config === null
              ? "config_invalid"
              : "no_patterns") as DoctorCheckReasonKind,
            reason:
              config === null
                ? "Patterns could not be loaded because configuration failed."
                : "No cleanup patterns are enabled.",
          }
        : {}),
    },
    {
      name: "disabled_patterns",
      ok: true,
      detail: String(config?.disabledPatterns?.length ?? 0),
    },

    {
      name: "opentui",
      ok: embeddedUi ? true : (openTui?.ok ?? false),
      detail: embeddedUi
        ? "embedded (standalone)"
        : (openTui?.detail ?? "missing; reinstall @kitsunekode/sweep"),
      ...(!embeddedUi && openTui && !openTui.ok
        ? { reasonKind: openTui.reason, reason: openTui.detail }
        : {}),
    },
    {
      name: "rust_engine",
      ok: rustOk,
      detail: rustOk
        ? rustExecutable
        : missingRust
          ? missingRust.detail
          : `${rustExecutable} (${rustProbe.reason ?? rustProbe.reasonKind})`,
      ...(!rustOk
        ? {
            reasonKind: missingRust
              ? missingRust.reasonKind
              : (rustProbe.reasonKind ?? ("not_installed" as const)),
            reason: missingRust
              ? missingRust.reason
              : (rustProbe.reason ?? "Native Rust engine binary was not found."),
          }
        : {}),
    },
    {
      name: "rust_apply_safety",
      ok: rustSafetyOk,
      detail: rustSafetyOk
        ? "controlled cancellation and plan identity supported"
        : "missing or incompatible native capabilities",
      ...(!rustSafetyOk
        ? {
            reasonKind: (rustOk
              ? "capabilities_unsupported"
              : "engine_unavailable") as DoctorCheckReasonKind,
            reason: rustOk
              ? "Native Rust engine lacks controlled cancellation or plan identity support."
              : "Native Rust engine is unavailable, so native apply capabilities could not be verified.",
          }
        : {}),
    },
    {
      name: "dry_scan",
      ok: scanOk,
      detail: scanDetail,
      ...(!scanOk
        ? {
            reasonKind: (config === null
              ? "config_invalid"
              : "scan_failed") as DoctorCheckReasonKind,
            reason: scanDetail,
          }
        : {}),
    },
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
          ...(check.reasonKind ? { reasonKind: check.reasonKind } : {}),
          ...(check.reason ? { reason: check.reason } : {}),
        })),
        hasWarnings,
      });
      await drainStdout();
      exitWith(hasWarnings ? EXIT.WARN : EXIT.OK);
    }

    printDoctorReport(checks, {
      targetDir,
      protocolVersion: PROTOCOL_VERSION,
      quiet: opts.quiet ?? false,
      verbose: opts.verbose ?? false,
    });

    exitWith(hasWarnings ? EXIT.WARN : EXIT.OK);
  } catch (err) {
    handleFatalError(err, { json: opts.json });
  }
}
