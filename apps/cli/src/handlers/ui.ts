import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliOptions, ScanPlan } from "@kitsunekode/sweep-protocol";
import { GuardrailError, assertSafeCwd } from "@kitsunekode/sweep-core/guardrails";
import {
  printAborted,
  printCleanResult,
  printDryRunNotice,
  type Spinner,
} from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import { runInteractiveCleanup } from "../orchestration/interactive-cleanup.js";
import {
  applyNoColor,
  assertOpenTuiAvailable,
  resolveEngineBackend,
  resolveProjectScanConfig,
  resolveScanConfig,
  resolveSelectionPolicy,
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

    const scanConfig = resolveScanConfig(targetDir, opts);

    await assertOpenTuiAvailable();

    const { runSweepUi } = await loadSweepUi();
    const { createSpinner } = await import("@kitsunekode/sweep-display");

    const scanSpinner: { current: Spinner | null } = { current: null };
    try {
      const outcome = await runInteractiveCleanup({
        targetDir,
        scanConfig,
        projectConfig,
        selectionPolicy,
        engine,
        dryRun: opts.dryRun,
        yes: opts.yes,
        forceLarge: opts.forceLarge,
        onScanStart: () => {
          scanSpinner.current?.stop();
          scanSpinner.current = createSpinner("Scanning for artifacts…");
        },
        onScanComplete: () => {
          scanSpinner.current?.stop();
          scanSpinner.current = null;
        },
        onScanProgress: (found) => {
          scanSpinner.current?.update(`Scanning for artifacts… (${found} found)`);
        },
        review: async (plan, ctx) =>
          runSweepUi(plan, {
            ...(ctx.yes ? { yes: true } : {}),
            ...(ctx.dryRun ? { dryRun: true } : {}),
            init: ctx.init,
          }),
      });

      if (outcome.type === "nothing") {
        console.log(outcome.reason === "no_candidates" ? "Nothing to clean." : "Nothing selected.");
        exitWith(EXIT.OK);
      }

      if (outcome.type === "aborted") {
        printAborted();
        exitWith(EXIT.ABORTED);
      }

      if (outcome.type === "dry_run") {
        printDryRunNotice();
        exitWith(EXIT.OK);
      }

      printCleanResult({
        ...outcome.cleanResult,
        failedPaths: outcome.report.failedPaths,
      });

      exitWith(outcome.report.failedCount > 0 ? EXIT.FAILURE : EXIT.OK);
    } finally {
      scanSpinner.current?.stop();
    }
  } catch (err) {
    handleFatalError(err);
  }
}
