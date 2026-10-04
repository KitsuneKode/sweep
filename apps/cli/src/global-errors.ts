import { abortActiveApply, isApplyActive } from "./apply-lifecycle.js";
import { handleFatalError } from "./errors.js";
import { isJsonStdoutActive } from "./json-output.js";

/** Shared by npm and compiled entrypoints: a broken sink must not hide apply. */
export function handleStdoutError(
  error: NodeJS.ErrnoException,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  if (error.code !== "EPIPE") return;
  if (isApplyActive()) {
    abortActiveApply();
    return;
  }
  // The structured writer reports incomplete output and a nonzero exit itself.
  // Do not exit before it can cancel/drain the scan's producer.
  if (isJsonStdoutActive()) return;
  // Preserve ordinary Unix `sweep scan | head` behavior for human output.
  exit(0);
}

export function installGlobalErrorHandlers(): void {
  process.stdout.on("error", handleStdoutError);
  process.stderr.on("error", () => {});
  process.on("unhandledRejection", handleFatalError);
  process.on("uncaughtException", handleFatalError);
}
