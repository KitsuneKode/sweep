import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PROTOCOL_VERSION } from "@kitsunekode/sweep-protocol";
import { loadConfig } from "@kitsunekode/sweep-core/config";
import { assertSafeCwd } from "@kitsunekode/sweep-core/guardrails";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import { applyNoColor } from "./shared.js";

export type DoctorHandlerOptions = {
  path?: string;
  color: boolean;
};

export async function handleDoctor(opts: DoctorHandlerOptions): Promise<void> {
  applyNoColor(opts.color);

  const targetDir = resolve(opts.path ?? ".");

  try {
    assertSafeCwd(targetDir);

    const configPath = resolve(targetDir, ".sweeprc");
    const config = loadConfig(targetDir);
    const checks = [
      { name: "protocol", ok: true, detail: PROTOCOL_VERSION },
      { name: "target", ok: true, detail: targetDir },
      {
        name: "config",
        ok: existsSync(configPath),
        detail: existsSync(configPath) ? configPath : "defaults",
      },
      { name: "patterns", ok: config.patterns.length > 0, detail: String(config.patterns.length) },
    ];

    for (const check of checks) {
      const status = check.ok ? "ok" : "warn";
      console.log(`${status}\t${check.name}\t${check.detail}`);
    }

    const hasWarnings = checks.some((check) => !check.ok);
    exitWith(hasWarnings ? EXIT.ABORTED : EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
