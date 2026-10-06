import { resolve } from "node:path";
import { recoverApplyJournal } from "@kitsunekode/sweep-core/apply-session";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { EXIT, exitWith, handleFatalError } from "../errors.js";
import { drainStdout, writeJson } from "./shared.js";

/** Recovery only reports observations; it cannot restore or delete data. */
export async function handleRecover(options: { journal: string; json?: boolean }): Promise<void> {
  try {
    const report = recoverApplyJournal(resolve(options.journal));
    if (options.json) writeJson(report);
    else {
      console.log(
        `${report.complete ? "Completed" : "Incomplete"} apply journal: ${sanitizeTerminalText(report.journalPath)}`,
      );
      console.log(`Target: ${sanitizeTerminalText(report.targetDir)}`);
      if (report.activeSession)
        console.log(
          `Apply lock held: host PID ${report.activeSession.pid} (${report.activeSession.processStatus}). This is an observation, not proof a crashed session is safe to unlock.`,
        );
      const counts = new Map<string, number>();
      for (const candidate of report.candidates)
        counts.set(candidate.status, (counts.get(candidate.status) ?? 0) + 1);
      for (const [status, count] of counts) console.log(`${status}: ${count}`);
      if (!report.complete)
        console.log(
          "Unknown means deletion may have been partial. Inspect the filesystem and rescan; this command never retries operations or releases an apply lock.",
        );
    }
    await drainStdout();
    exitWith(report.complete ? EXIT.OK : EXIT.WARN);
  } catch (error) {
    handleFatalError(error);
  }
}
