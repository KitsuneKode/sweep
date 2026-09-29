import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  resolveEngineBackend,
  resolveProjectScanConfig,
  resolveScanConfig,
  resolveSelectionPolicy,
  resolveScanTarget,
  runScanToPlan,
  writeJson,
} from "./shared.js";

export async function handlePlan(pathArg: string, opts: CliOptions): Promise<void> {
  applyNoColor(opts.color);

  try {
    const targetDir = resolveScanTarget(pathArg);
    const config = resolveScanConfig(targetDir, opts);
    const projectConfig = resolveProjectScanConfig(targetDir, opts);
    const selectionPolicy = resolveSelectionPolicy(opts);
    const engine = resolveEngineBackend(opts);
    const { plan } = await runScanToPlan(targetDir, config, {
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
