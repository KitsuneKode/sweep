import { resolve } from "node:path";
import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { writeInitSweeprc } from "@kitsunekode/sweep-core/config";
import { assertSafeCwd, assertTargetDirectory } from "@kitsunekode/sweep-core/guardrails";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import { sanitizeTerminalText } from "@kitsunekode/sweep-display";
import { applyNoColor, resolveTargetPath, warnIgnoredOptions } from "./shared.js";

export type InitHandlerOptions = CliOptions & {
  path?: string;
  force: boolean;
};

export async function handleInit(opts: InitHandlerOptions): Promise<void> {
  applyNoColor(opts.color);
  warnIgnoredOptions(opts, "init");

  const targetDir = resolveTargetPath(opts.path ?? ".");
  const configPath = resolve(targetDir, ".sweeprc");

  try {
    assertSafeCwd(targetDir);
    assertTargetDirectory(targetDir);

    const result = writeInitSweeprc(configPath, opts.force);
    const shownPath = sanitizeTerminalText(configPath);
    if (result === "exists") {
      console.error(`error: ${shownPath} already exists (use --force to overwrite)`);
      exitWith(EXIT.GUARDRAIL);
    }

    console.log(`Created ${shownPath}`);
    exitWith(EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
