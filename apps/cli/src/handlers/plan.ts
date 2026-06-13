import { resolve } from "node:path";
import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { assertSafeCwd } from "@kitsunekode/sweep-core/guardrails";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  resolveEngineBackend,
  resolveProjectScanConfig,
  resolveScanConfig,
  resolveSelectionPolicy,
  runScanToPlan,
  writeJson,
} from "./shared.js";

export async function handlePlan(pathArg: string, opts: CliOptions): Promise<void> {
  applyNoColor(opts.color);

  const targetDir = resolve(pathArg);

  try {
    assertSafeCwd(targetDir);
    const config = resolveScanConfig(targetDir, opts);
    const projectConfig = resolveProjectScanConfig(targetDir, opts);
    const selectionPolicy = resolveSelectionPolicy(opts);
    const engine = resolveEngineBackend(opts);
    const { plan } = runScanToPlan(targetDir, config, {
      selectionPolicy,
      engine,
      projectConfig,
    });

    writeJson(plan);
    exitWith(EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
