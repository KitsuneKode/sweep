import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PROTOCOL_VERSION } from "@kitsunekode/sweep-protocol";
import { loadConfig } from "@kitsunekode/sweep-core/config";
import { assertSafeCwd } from "@kitsunekode/sweep-core/guardrails";
import {
  isRustEngineAvailable,
  resolveRustEngineBinary,
} from "@kitsunekode/sweep-core/rust-engine";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import { applyNoColor, isOpenTuiAvailable, writeJson } from "./shared.js";

export type DoctorHandlerOptions = {
  path?: string;
  color: boolean;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
};

type DoctorCheck = {
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

function collectDoctorChecks(targetDir: string): DoctorCheck[] {
  const configPath = resolve(targetDir, ".sweeprc");
  const config = loadConfig(targetDir);
  const rustBinary = resolveRustEngineBinary();
  const rustOk = isRustEngineAvailable();
  const duOk = duAvailable();
  const openTuiOk = isOpenTuiAvailable();

  return [
    { name: "protocol", ok: true, detail: PROTOCOL_VERSION },
    { name: "target", ok: true, detail: targetDir },
    {
      name: "config",
      ok: existsSync(configPath),
      detail: existsSync(configPath) ? configPath : "defaults",
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
  ];
}

export async function handleDoctor(opts: DoctorHandlerOptions): Promise<void> {
  applyNoColor(opts.color);

  const targetDir = resolve(opts.path ?? ".");

  try {
    assertSafeCwd(targetDir);

    const checks = collectDoctorChecks(targetDir);
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
