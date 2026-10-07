import type { CliOptions } from "@kitsunekode/sweep-protocol";
import { historyFilePath, readHistory, summarizeHistory } from "@kitsunekode/sweep-core/history";
import { printStatsSummary } from "@kitsunekode/sweep-display";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import { applyNoColor, drainStdout, warnIgnoredOptions, writeJson } from "./shared.js";

export type StatsHandlerOptions = CliOptions & { json?: boolean };

const RECENT_SESSIONS = 5;

/** `sweep stats` - retained estimated cleanup bytes plus recent cleanup sessions. */
export async function handleStats(opts: StatsHandlerOptions): Promise<void> {
  applyNoColor(opts.color);
  warnIgnoredOptions(opts, "stats", { except: ["--json"] });

  try {
    // Total only the retained byte window, rather than the default recent page.
    const entries = readHistory(Number.MAX_SAFE_INTEGER);
    const summary = summarizeHistory(entries);
    const recent = entries.slice(-RECENT_SESSIONS);

    if (opts.json) {
      writeJson({
        scope: "retained-history",
        byteBasis: "plan-estimate",
        summary,
        historyFile: historyFilePath(),
        recent,
      });
    } else {
      printStatsSummary(summary, recent, historyFilePath(), entries.length);
    }
    await drainStdout();
    exitWith(EXIT.OK);
  } catch (err) {
    handleFatalError(err, { json: opts.json });
  }
}
