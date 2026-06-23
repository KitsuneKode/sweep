import { resolve } from "node:path";
import { writeInitSweeprc } from "@kitsunekode/sweep-core/config";
import { assertSafeCwd } from "@kitsunekode/sweep-core/guardrails";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import { applyNoColor } from "./shared.js";

export type InitHandlerOptions = {
  path?: string;
  force: boolean;
  color: boolean;
};

export async function handleInit(opts: InitHandlerOptions): Promise<void> {
  applyNoColor(opts.color);

  const targetDir = resolve(opts.path ?? ".");
  const configPath = resolve(targetDir, ".sweeprc");

  try {
    assertSafeCwd(targetDir);

    const result = writeInitSweeprc(configPath, opts.force);
    if (result === "exists") {
      console.error(`error: ${configPath} already exists (use --force to overwrite)`);
      exitWith(EXIT.ABORTED);
    }

    console.log(`Created ${configPath}`);
    exitWith(EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
