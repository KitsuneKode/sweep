import {
  GuardrailError,
  isApplyRefusedError,
  isApplyOutcomeUnknownError,
} from "@kitsunekode/sweep-core/guardrails";
import { ConfigParseError } from "@kitsunekode/sweep-core/config";
import { PlanValidationError } from "@kitsunekode/sweep-core/plan";
import { sanitizeTerminalText } from "@kitsunekode/sweep-protocol";
import { printError } from "@kitsunekode/sweep-display";

export const EXIT = {
  OK: 0,
  ABORTED: 1,
  GUARDRAIL: 2,
  CONFIG_PARSE: 3,
  FAILURE: 4,
  WARN: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export function resolveExitCode(err: unknown): ExitCode {
  if (isApplyOutcomeUnknownError(err)) return EXIT.FAILURE;
  if (isApplyRefusedError(err)) return EXIT.GUARDRAIL;
  if (err instanceof GuardrailError) {
    return err.code === EXIT.ABORTED || err.code === EXIT.GUARDRAIL || err.code === EXIT.FAILURE
      ? err.code
      : EXIT.FAILURE;
  }
  if (
    err instanceof PlanValidationError ||
    err instanceof ConfigParseError ||
    err instanceof SyntaxError
  ) {
    return EXIT.CONFIG_PARSE;
  }
  return EXIT.FAILURE;
}

export function exitWith(code: ExitCode): never {
  process.exit(code);
}

let fatalErrorJsonMode = false;
export function setFatalErrorJsonMode(enabled: boolean): void {
  fatalErrorJsonMode = enabled;
}
export function isFatalErrorJsonMode(): boolean {
  return fatalErrorJsonMode;
}

export function fatalErrorDocument(err: unknown, applyOutcome?: "not_started" | "unknown") {
  const refused = isApplyRefusedError(err);
  const unknownOutcome = isApplyOutcomeUnknownError(err);
  return {
    type: "error",
    protocolVersion: "1",
    exitCode: resolveExitCode(err),
    code: unknownOutcome
      ? "apply_outcome_unknown"
      : refused
        ? err.refusalCode
        : resolveExitCode(err) === EXIT.GUARDRAIL
          ? "guardrail"
          : resolveExitCode(err) === EXIT.CONFIG_PARSE
            ? "invalid_input"
            : "failure",
    retryable: refused && err.refusalCode === "apply_busy",
    ...(unknownOutcome
      ? {
          hint: "Inspect disk and the recovery journal before making a newly reviewed plan. Never retry an unknown apply automatically.",
        }
      : refused
        ? {
            hint:
              err.refusalCode === "apply_busy"
                ? "Inspect the lock owner and journal. Retry only after the holder finishes; do not remove a lock automatically."
                : err.refusalCode === "resource_limit_exceeded"
                  ? "Review a smaller selection or subtree within the resource budget. Nothing was removed; do not increase limits automatically."
                  : err.refusalCode === "size_limit_exceeded"
                    ? "Review the queue or configured size policy. Do not widen deletion authorization automatically."
                    : "Inspect unreadable or unsupported entries before creating a newly reviewed plan.",
          }
        : {}),
    ...(unknownOutcome || refused || applyOutcome
      ? { applyOutcome: unknownOutcome ? "unknown" : refused ? "not_started" : applyOutcome }
      : {}),
    message: sanitizeTerminalText(
      (err instanceof Error ? err.message : String(err)).slice(0, 4096),
    ),
  };
}

export function handleFatalError(
  err: unknown,
  options: { json?: boolean | undefined; applyOutcome?: "not_started" | "unknown" } = {},
): never {
  if (options.json) console.error(JSON.stringify(fatalErrorDocument(err, options.applyOutcome)));
  else printError(err instanceof Error ? err.message : String(err));
  exitWith(resolveExitCode(err));
}
