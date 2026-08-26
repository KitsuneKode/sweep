import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PROTOCOL_VERSION } from "@kitsunekode/sweep-protocol";
import { loadConfig, validateProjectConfigFile } from "@kitsunekode/sweep-core/config";
import { assertSafeCwd } from "@kitsunekode/sweep-core/guardrails";
import {
  isRustEngineAvailable,
  resolveRustEngineBinary,
} from "@kitsunekode/sweep-core/rust-engine";
import { scan } from "@kitsunekode/sweep-core/scanner";
import { formatBytes } from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import { applyNoColor, isOpenTuiAvailable, writeJson } from "./shared.js";

export type DoctorHandlerOptions = {
  path?: string;
  color: boolean;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
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

export async function collectDoctorChecks(targetDir: string): Promise<DoctorCheck[]> {
  const configPath = resolve(targetDir, ".sweeprc");
  const config = loadConfig(targetDir);
  const rustBinary = resolveRustEngineBinary();
  const rustOk = isRustEngineAvailable();
  const duOk = duAvailable();
  const openTuiOk = isOpenTuiAvailable();
  const hasConfigFile = existsSync(configPath);
  const configValidity = hasConfigFile
    ? validateProjectConfigFile(configPath, targetDir)
    : { ok: true as const, path: configPath };

  let scanOk = true;
  let scanDetail = "not run";
  try {
    const result = await scan(targetDir, config, false);
    scanDetail = `${result.entries.length} candidates · ${formatBytes(result.estimatedTotalBytes)} · ${result.scannedDirs} dirs`;
  } catch (error) {
    scanOk = false;
    scanDetail = error instanceof Error ? error.message : String(error);
  }

  return [
    { name: "protocol", ok: true, detail: PROTOCOL_VERSION },
    { name: "target", ok: true, detail: targetDir },
    {
      name: "config",
      ok: configValidity.ok,
      detail: hasConfigFile
        ? configValidity.ok
          ? configPath
          : configValidity.detail
        : "defaults (no .sweeprc)",
    },
    { name: "patterns", ok: config.patterns.length > 0, detail: String(config.patterns.length) },
    {
      name: "disabled_patterns",
      ok: true,
      detail: String(config.disabledPatterns?.length ?? 0),
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

  const targetDir = resolve(opts.path ?? ".");

  try {
    assertSafeCwd(targetDir);

    const checks = await collectDoctorChecks(targetDir);
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
      console.log(`${status}\t${check.name}\t${check.detail}`);
    }

    exitWith(hasWarnings ? EXIT.WARN : EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
