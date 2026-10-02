import { spawnSync } from "node:child_process";

import { fileURLToPath } from "node:url";
import type { CliOptions, ScanPlan } from "@kitsunekode/sweep-protocol";
import { CATALOG_PATTERNS, DEFAULT_PATTERN_SET } from "@kitsunekode/sweep-core/catalog";
import { GuardrailError, assertSizeLimit } from "@kitsunekode/sweep-core/guardrails";
import { getSelectedBytes } from "@kitsunekode/sweep-core/plan";
import {
  printAborted,
  printCleanResult,
  printDryRunNotice,
  printInterrupted,
} from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  assertOpenTuiAvailable,
  executePlanDeletion,
  resolveEngineBackend,
  resolveScanConfig,
  resolveSelectionPolicy,
  resolveScanTarget,
  warnIgnoredOptions,
} from "./shared.js";

function isModuleNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: string }).code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  return (error as { name?: string }).name === "ResolveMessage";
}

function isBunRuntime(): boolean {
  return typeof process.versions.bun === "string";
}

function bunIsInstalled(): boolean {
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

/**
 * The interactive UI depends on OpenTUI's native FFI, which needs the Bun
 * runtime. When `sweep ui` is launched under Node, transparently re-exec the
 * same command under Bun if it is installed; otherwise fail with clear guidance.
 * Returns true when the caller should continue (already on Bun).
 */
function ensureBunRuntimeForUi(): boolean {
  if (isBunRuntime()) return true;

  if (!bunIsInstalled()) {
    throw new GuardrailError(
      "The interactive UI (`sweep ui`) needs the Bun runtime.\n" +
        "  • Install Bun: https://bun.sh\n" +
        "  • Or use `sweep` / `sweep clean` / `sweep scan` instead (these run on Node).",
    );
  }

  const script = process.argv[1] ?? fileURLToPath(import.meta.url);
  const result = spawnSync("bun", [script, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

/**
 * Runtime contract for the OpenTUI app. Declared locally so the Node CLI does
 * not type-depend on the React/JSX UI package - it is loaded dynamically.
 */
type SweepUiOutcome =
  | { type: "apply"; plan: ScanPlan; trash?: boolean }
  | { type: "rescan"; disabledPatterns: string[]; extraPatterns: string[] }
  | { type: "abort" };

export interface SweepUiModule {
  runSweepUiStreaming: (options: {
    targetDir: string;
    config: import("@kitsunekode/sweep-protocol").SweepConfig;
    selectionPolicy: import("@kitsunekode/sweep-protocol").SelectionPolicy;
    engine: "js" | "rust";
    dryRun?: boolean;
    trash?: boolean;
    yes?: boolean;
    init?: {
      catalogPatterns?: string[];
      disabledPatterns?: string[];
      extraPatterns?: string[];
    };
  }) => Promise<SweepUiOutcome>;
}

/**
 * Load the OpenTUI app. In a published build, `sweep-ui.js` is emitted next to
 * the bundled `sweep.js`; running from source falls back to the workspace
 * package so `sweep ui` works in development too.
 *
 * Standalone compiled binaries register the UI module statically at startup
 * (see bin-standalone.ts) so Bun embeds the UI code and OpenTUI native assets;
 * that registration short-circuits the dynamic resolution below.
 */
export function registerUiModule(mod: SweepUiModule): void {
  registeredUiModule = mod;
}

let registeredUiModule: SweepUiModule | null = null;

async function loadSweepUi(): Promise<SweepUiModule> {
  if (registeredUiModule) return registeredUiModule;
  const sibling = new URL("./sweep-ui.js", import.meta.url).href;
  const workspacePackage = "@kitsunekode/sweep-ui";
  try {
    return (await import(sibling)) as SweepUiModule;
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
    try {
      return (await import(workspacePackage)) as SweepUiModule;
    } catch {
      throw error;
    }
  }
}

export async function handleUi(pathArg: string, opts: CliOptions): Promise<void> {
  applyNoColor(opts.color);
  // The TUI is interactive: JSON/quiet/verbose have no meaning inside it.
  // yes/force-large gate --force-large; trash/dry-run reach the UI directly.
  warnIgnoredOptions(opts, "ui", {
    scans: true,
    except: ["--yes", "--force-large", "--trash", "--dry-run"],
  });

  try {
    const targetDir = resolveScanTarget(pathArg);

    if (!process.stdout.isTTY) {
      throw new GuardrailError("sweep ui requires a TTY terminal.");
    }

    // Native FFI for the TUI requires Bun; re-exec under Bun when on Node.
    ensureBunRuntimeForUi();

    if (opts.forceLarge && !opts.yes) {
      throw new GuardrailError(
        "--force-large requires --yes. Large deletes must be non-interactive.",
      );
    }

    const selectionPolicy = resolveSelectionPolicy(opts);
    const engine = resolveEngineBackend(opts);

    const scanConfig = resolveScanConfig(targetDir, opts);

    await assertOpenTuiAvailable();

    const { runSweepUiStreaming } = await loadSweepUi();

    const outcome = await runSweepUiStreaming({
      targetDir,
      config: scanConfig,
      selectionPolicy,
      engine,
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.trash ? { trash: true } : {}),
      init: {
        // The pane lists the whole curated catalog; extraPatterns carries what
        // is enabled beyond defaults (opt-in catalog picks + customs alike).
        catalogPatterns: [...CATALOG_PATTERNS],
        disabledPatterns: scanConfig.disabledPatterns ?? [],
        extraPatterns: scanConfig.patterns.filter((pattern) => !DEFAULT_PATTERN_SET.has(pattern)),
      },
    });

    if (outcome.type === "abort") {
      printAborted();
      exitWith(EXIT.ABORTED);
    }

    if (outcome.type === "rescan") {
      // Streaming mode rescans internally; this outcome is legacy.
      printAborted();
      exitWith(EXIT.ABORTED);
    }

    const selectedPlan = outcome.plan;
    // `--trash` or the confirm dialog's `t` toggle: either asks for reversible.
    const useTrash = Boolean(opts.trash) || outcome.trash === true;

    if (selectedPlan.selectedCandidateIds.length === 0) {
      console.log("Nothing selected.");
      exitWith(EXIT.OK);
    }

    assertSizeLimit(getSelectedBytes(selectedPlan), scanConfig.maxSizeGB, opts.forceLarge ?? false);

    if (opts.dryRun) {
      printDryRunNotice();
      exitWith(EXIT.OK);
    }

    const { report, cleanResult, interrupted, trashDir } = await executePlanDeletion(
      selectedPlan,
      engine,
      {
        maxSizeGB: scanConfig.maxSizeGB,
        forceLarge: opts.forceLarge,
        ...(useTrash ? { trash: true } : {}),
      },
    );

    printCleanResult(
      {
        ...cleanResult,
        failedPaths: report.failedPaths,
      },
      {
        ...(report.outcomes ? { outcomes: report.outcomes } : {}),
        ...(trashDir ? { trashDir } : {}),
      },
    );
    if (interrupted) {
      printInterrupted(report.deletedCount, selectedPlan.selectedCandidateIds.length, {
        verb: trashDir ? "moved" : "deleted",
      });
    }

    exitWith(interrupted ? EXIT.ABORTED : report.failedCount > 0 ? EXIT.FAILURE : EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
