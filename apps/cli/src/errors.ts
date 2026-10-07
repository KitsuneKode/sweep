import { GuardrailError, isApplyRefusedError } from "@kitsunekode/sweep-core/guardrails";
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
  if (err instanceof GuardrailError) {
    return err.code as ExitCode;
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

export function fatalErrorDocument(err: unknown, applyOutcome?: "not_started" | "unknown") {
  const refused = isApplyRefusedError(err);
  return {
    type: "error",
    protocolVersion: "1",
    exitCode: resolveExitCode(err),
    code: refused
      ? err.refusalCode
      : resolveExitCode(err) === EXIT.GUARDRAIL
        ? "guardrail"
        : resolveExitCode(err) === EXIT.CONFIG_PARSE
          ? "invalid_input"
          : "failure",
    retryable: refused && err.refusalCode === "apply_busy",
    ...(refused
      ? {
          hint:
            err.refusalCode === "apply_busy"
              ? "Inspect the lock owner and journal. Retry only after the holder finishes; do not remove a lock automatically."
              : err.refusalCode === "size_limit_exceeded"
                ? "Review the queue or configured size policy. Do not widen deletion authorization automatically."
                : "Inspect unreadable or unsupported entries before creating a newly reviewed plan.",
        }
      : {}),
    ...(refused || applyOutcome ? { applyOutcome: refused ? "not_started" : applyOutcome } : {}),
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
