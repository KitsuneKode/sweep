import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliOptions, ScanPlan } from "@kitsunekode/sweep-protocol";
import { DEFAULT_PATTERNS, buildRescanConfig } from "@kitsunekode/sweep-core/config";
import { GuardrailError, assertSafeCwd, assertSizeLimit } from "@kitsunekode/sweep-core/guardrails";
import { getSelectedBytes } from "@kitsunekode/sweep-core/plan";
import { printAborted, printCleanResult, printDryRunNotice } from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import {
  applyNoColor,
  assertOpenTuiAvailable,
  executePlanDeletion,
  resolveEngineBackend,
  resolveProjectScanConfig,
  resolveScanConfig,
  resolveSelectionPolicy,
  runScanToPlan,
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
 * not type-depend on the React/JSX UI package — it is loaded dynamically.
 */
type SweepUiOutcome =
  | { type: "apply"; plan: ScanPlan }
  | { type: "rescan"; disabledPatterns: string[]; extraPatterns: string[] }
  | { type: "abort" };

interface SweepUiModule {
  runSweepUi: (
    plan: ScanPlan,
    options?: {
      yes?: boolean;
      dryRun?: boolean;
      init?: {
        catalogPatterns?: string[];
        disabledPatterns?: string[];
        extraPatterns?: string[];
      };
    },
  ) => Promise<SweepUiOutcome>;
}

/**
 * Load the OpenTUI app. In a published build, `sweep-ui.js` is emitted next to
 * the bundled `sweep.js`; running from source falls back to the workspace
 * package so `sweep ui` works in development too.
 *
 * The fallback specifier is held in a variable so neither TypeScript nor the
 * bundler statically resolves the JSX UI module into the Node CLI.
 */
async function loadSweepUi(): Promise<SweepUiModule> {
  const sibling = new URL("./sweep-ui.js", import.meta.url).href;
  const workspacePackage = "@kitsunekode/sweep-ui";
  try {
    return (await import(sibling)) as SweepUiModule;
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
    return (await import(workspacePackage)) as SweepUiModule;
  }
}

export async function handleUi(pathArg: string, opts: CliOptions): Promise<void> {
  applyNoColor(opts.color);

  const targetDir = resolve(pathArg);

  try {
    assertSafeCwd(targetDir);

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

    const projectConfig = resolveProjectScanConfig(targetDir, opts);
    const selectionPolicy = resolveSelectionPolicy(opts);
    const engine = resolveEngineBackend(opts);

    let scanConfig = resolveScanConfig(targetDir, opts);
    let disabledPatterns = scanConfig.disabledPatterns ?? [];
    let extraPatterns = scanConfig.patterns.filter(
      (pattern) => !new Set<string>(DEFAULT_PATTERNS).has(pattern),
    );
    let selectedPlan;

    await assertOpenTuiAvailable();

    const { runSweepUi } = await loadSweepUi();
    const { createSpinner } = await import("@kitsunekode/sweep-display");

    while (true) {
      const spinner = createSpinner("Scanning for artifacts…");
      let found = 0;
      let plan;
      try {
        ({ plan } = await runScanToPlan(targetDir, scanConfig, {
          selectionPolicy,
          engine,
          projectConfig,
          onEntrySized: () => {
            found++;
            spinner.update(`Scanning for artifacts… (${found} found)`);
          },
        }));
      } finally {
        spinner.stop();
      }

      if (plan.candidates.length === 0) {
        console.log("Nothing to clean.");
        exitWith(EXIT.OK);
      }

      const outcome = await runSweepUi(plan, {
        yes: opts.yes,
        dryRun: opts.dryRun,
        init: {
          catalogPatterns: [...DEFAULT_PATTERNS],
          disabledPatterns,
          extraPatterns,
        },
      });

      if (outcome.type === "abort") {
        printAborted();
        exitWith(EXIT.ABORTED);
      }

      if (outcome.type === "rescan") {
        disabledPatterns = outcome.disabledPatterns;
        extraPatterns = outcome.extraPatterns;
        scanConfig = buildRescanConfig(scanConfig, {
          disabledPatterns,
          extraPatterns,
        });
        continue;
      }

      selectedPlan = outcome.plan;
      break;
    }

    const selectedBytes = getSelectedBytes(selectedPlan);
    assertSizeLimit(selectedBytes, scanConfig.maxSizeGB, opts.forceLarge);

    if (selectedPlan.selectedCandidateIds.length === 0) {
      console.log("Nothing selected.");
      exitWith(EXIT.OK);
    }

    if (opts.dryRun) {
      printDryRunNotice();
      exitWith(EXIT.OK);
    }

    const { report, cleanResult } = await executePlanDeletion(selectedPlan, engine);
    printCleanResult({
      ...cleanResult,
      failedPaths: report.failedPaths,
    });

    exitWith(report.failedCount > 0 ? EXIT.FAILURE : EXIT.OK);
  } catch (err) {
    handleFatalError(err);
  }
}
