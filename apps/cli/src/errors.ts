import { GuardrailError } from "@kitsunekode/sweep-core/guardrails";
import { ConfigParseError } from "@kitsunekode/sweep-core/config";
import { PlanValidationError } from "@kitsunekode/sweep-core/plan";
import { printError } from "@kitsunekode/sweep-display";

export const EXIT = {
  OK: 0,
  ABORTED: 1,
  GUARDRAIL: 2,
  CONFIG_PARSE: 3,
  FAILURE: 4,
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

export function handleFatalError(err: unknown): never {
  printError(err instanceof Error ? err.message : String(err));
  exitWith(resolveExitCode(err));
}
