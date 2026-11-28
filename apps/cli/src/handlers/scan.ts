import type { CliOptions, ScanCandidate, ScanEvent } from "@kitsunekode/sweep-protocol";
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

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function candidateChangedAfterEnrichment(prev: ScanCandidate, next: ScanCandidate): boolean {
  return (
    prev.riskTier !== next.riskTier ||
    prev.selectedByDefault !== next.selectedByDefault ||
    prev.estimatedBytes !== next.estimatedBytes ||
    prev.bytesKnown !== next.bytesKnown ||
    prev.projectRoot !== next.projectRoot ||
    prev.projectActiveMs !== next.projectActiveMs ||
    prev.worktreeOf !== next.worktreeOf ||
    prev.worktreeState !== next.worktreeState ||
    !sameStringArray(prev.reasons, next.reasons)
  );
}

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
      const lastEmitted = new Map<string, ScanCandidate>();
      const { result, plan } = await runScanToPlan(targetDir, config, {
        exact: false,
        waitForConsumer: waitForStdoutConsumer,
        selectionPolicy,
        ...(opts.idle !== undefined ? { idleMs: opts.idle } : {}),
        engine,
        projectConfig,
        resourceProfile: opts.resourceProfile,
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
          lastEmitted.set(candidate.id, candidate);
          writeJsonLine({ type: "candidate_found", candidate } satisfies ScanEvent);
        },
        onEntrySized: (entry) => {
          const candidate = toCandidate(entry);
          lastEmitted.set(candidate.id, candidate);
          writeJsonLine({ type: "candidate_updated", candidate } satisfies ScanEvent);
        },
      });

      // Reconcile streamed candidates with the authoritative enriched plan so
      // consumers observe post-enrichment risk tiers (git-tracked, worktree,
      // tool-home, workspace-stub, symlink-alias) and project/worktree metadata
      // identical to `sweep scan --json` before `scan_completed`.
      for (const candidate of plan.candidates) {
        const prior = lastEmitted.get(candidate.id);
        if (!prior) {
          const wait = waitForStdoutConsumer();
          if (wait) await wait;
          writeJsonLine({ type: "candidate_found", candidate } satisfies ScanEvent);
        } else if (candidateChangedAfterEnrichment(prior, candidate)) {
          const wait = waitForStdoutConsumer();
          if (wait) await wait;
          writeJsonLine({ type: "candidate_updated", candidate } satisfies ScanEvent);
        }
      }

      writeJsonLine({
        type: "scan_completed",
        summary: {
          candidateCount: plan.summary.candidateCount,
          estimatedTotalBytes: plan.summary.estimatedTotalBytes,
          scannedDirs: plan.summary.scannedDirs,
          // Sparse - same convention as ScanPlan.summary.skippedDirs.
          ...(result.skippedDirs > 0 ? { skippedDirs: result.skippedDirs } : {}),
          exact: plan.summary.exact,
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
        ...(opts.idle !== undefined ? { idleMs: opts.idle } : {}),
        engine,
        projectConfig,
        resourceProfile: opts.resourceProfile,
      });
      writeJson(plan);
      await drainStdout();
      exitWith(EXIT.OK);
    }

    await runScanWithDisplay(targetDir, config, {
      selectionPolicy,
      ...(opts.idle !== undefined ? { idleMs: opts.idle } : {}),
      engine,
      projectConfig,
      resourceProfile: opts.resourceProfile,
      output: {
        ...(opts.quiet ? { quiet: true } : {}),
        ...(opts.verbose ? { verbose: true } : {}),
      },
    });
    await drainStdout();
    exitWith(EXIT.OK);
  } catch (err) {
    handleFatalError(err, { json: opts.json || opts.jsonStream });
  }
}
