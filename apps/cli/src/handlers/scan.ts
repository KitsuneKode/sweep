import { resolve } from "node:path";
import type { CliOptions, ScanEvent } from "@kitsunekode/sweep-protocol";
import { assertSafeCwd } from "@kitsunekode/sweep-core/guardrails";
import { toCandidate } from "@kitsunekode/sweep-core/planner";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  resolveEngineBackend,
  resolveProjectScanConfig,
  resolveScanConfig,
  resolveSelectionPolicy,
  runScanToPlan,
  runScanWithDisplay,
  writeJson,
  writeJsonLine,
} from "./shared.js";

export async function handleScan(
  pathArg: string,
  opts: CliOptions & { json?: boolean; jsonStream?: boolean },
): Promise<void> {
  applyNoColor(opts.color);

  const targetDir = resolve(pathArg);

  try {
    assertSafeCwd(targetDir);
    const config = resolveScanConfig(targetDir, opts);
    const projectConfig = resolveProjectScanConfig(targetDir, opts);
    const selectionPolicy = resolveSelectionPolicy(opts);
    const engine = resolveEngineBackend(opts);

    if (opts.jsonStream) {
      const startedEvent: ScanEvent = { type: "scan_started", targetDir };
      writeJsonLine(startedEvent);

      const { result } = await runScanToPlan(targetDir, config, {
        exact: false,
        selectionPolicy,
        engine,
        projectConfig,
        onEntry: (entry) => {
          const candidate = toCandidate(entry);
          writeJsonLine({ type: "candidate_found", candidate } satisfies ScanEvent);
        },
        onEntrySized: (entry) => {
          const candidate = toCandidate(entry);
          writeJsonLine({ type: "candidate_updated", candidate } satisfies ScanEvent);
        },
      });

      writeJsonLine({
        type: "scan_completed",
        summary: {
          candidateCount: result.entries.length,
          estimatedTotalBytes: result.estimatedTotalBytes,
          scannedDirs: result.scannedDirs,
        },
      } satisfies ScanEvent);
      exitWith(EXIT.OK);
    }

    if (opts.json) {
      const { plan } = await runScanToPlan(targetDir, config, {
        selectionPolicy,
        engine,
        projectConfig,
      });
      writeJson(plan);
      exitWith(EXIT.OK);
    }

    await runScanWithDisplay(targetDir, config, {
      selectionPolicy,
      engine,
      projectConfig,
      output: {
        ...(opts.quiet ? { quiet: true } : {}),
        ...(opts.verbose ? { verbose: true } : {}),
      },
    });
    exitWith(EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
