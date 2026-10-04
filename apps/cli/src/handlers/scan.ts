import type { CliOptions, ScanEvent } from "@kitsunekode/sweep-protocol";
import { toCandidate } from "@kitsunekode/sweep-core/planner";
import { GuardrailError } from "@kitsunekode/sweep-core/guardrails";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  drainStdout,
  resolveEngineBackend,
  resolveProjectScanConfig,
  resolveScanConfig,
  resolveSelectionPolicy,
  resolveScanTarget,
  runScanToPlan,
  runScanWithDisplay,
  warnIgnoredOptions,
  writeJson,
  writeJsonLine,
  waitForStdoutConsumer,
} from "./shared.js";

export async function handleScan(
  pathArg: string,
  opts: CliOptions & { json?: boolean; jsonStream?: boolean },
): Promise<void> {
  applyNoColor(opts.color);
  warnIgnoredOptions(opts, "scan", {
    scans: true,
    except: ["--json", "--quiet", "--verbose"],
  });

  try {
    if (opts.json && opts.jsonStream) {
      throw new GuardrailError(
        "Choose one: --json emits a plan; --json-stream emits NDJSON events.",
      );
    }

    const targetDir = resolveScanTarget(pathArg);
    const config = resolveScanConfig(targetDir, opts);
    const projectConfig = resolveProjectScanConfig(targetDir, opts);
    const selectionPolicy = resolveSelectionPolicy(opts);
    const engine = resolveEngineBackend(opts);

    if (opts.jsonStream) {
      const scanStartedAt = performance.now();
      const { result } = await runScanToPlan(targetDir, config, {
        exact: false,
        waitForConsumer: waitForStdoutConsumer,
        selectionPolicy,
        engine,
        projectConfig,
        onStarted: (targetIdentity) => {
          writeJsonLine({
            type: "scan_started",
            targetDir,
            ...(targetIdentity ? { targetIdentity } : {}),
          } satisfies ScanEvent);
        },
        onProgress: (progress) => {
          writeJsonLine({ type: "scan_progress", ...progress } satisfies ScanEvent);
        },
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
          // Sparse - same convention as ScanPlan.summary.skippedDirs.
          ...(result.skippedDirs > 0 ? { skippedDirs: result.skippedDirs } : {}),
          // Wall time for the whole scan call - engine comparison without
          // instrumenting the consumer.
          elapsedMs: Math.round(performance.now() - scanStartedAt),
        },
      } satisfies ScanEvent);
      await drainStdout();
      exitWith(EXIT.OK);
    }

    if (opts.json) {
      const { plan } = await runScanToPlan(targetDir, config, {
        selectionPolicy,
        engine,
        projectConfig,
      });
      writeJson(plan);
      await drainStdout();
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
    await drainStdout();
    exitWith(EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
