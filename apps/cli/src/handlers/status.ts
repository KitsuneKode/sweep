import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { IDLE_WINDOW_MS } from "@kitsunekode/sweep-protocol";
import { summarizeStatus } from "@kitsunekode/sweep-core/status";
import { printStatusSummary } from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  drainStdout,
  resolveEngineBackend,
  resolveProjectScanConfig,
  resolveScanConfig,
  resolveScanTarget,
  resolveSelectionPolicy,
  runScanToPlan,
  warnIgnoredOptions,
  writeJson,
} from "./shared.js";

/**
 * `sweep status` - a scan, summarised: what could be freed, which kinds hold
 * it, which idle projects, how many items are protected. Read-only. `--json`
 * emits the StatusSummary (a few hundred bytes, however many candidates).
 * `--idle <age>` sets the idle window here instead of selecting anything.
 */
export async function handleStatus(
  pathArg: string,
  opts: CliOptions & { json?: boolean },
): Promise<void> {
  applyNoColor(opts.color);
  warnIgnoredOptions(opts, "status", { scans: true, except: ["--json", "--idle"] });

  try {
    const targetDir = resolveScanTarget(pathArg);
    const config = resolveScanConfig(targetDir, opts);
    const projectConfig = resolveProjectScanConfig(targetDir, opts);
    const { plan } = await runScanToPlan(targetDir, config, {
      selectionPolicy: resolveSelectionPolicy(opts),
      engine: resolveEngineBackend(opts),
      projectConfig,
      resourceProfile: opts.resourceProfile,
    });
    const status = summarizeStatus(plan, Date.now(), opts.idle ?? IDLE_WINDOW_MS);
    if (opts.json) writeJson(status);
    else printStatusSummary(status);
    await drainStdout();
    exitWith(EXIT.OK);
  } catch (err) {
    handleFatalError(err, { json: opts.json });
  }
}
