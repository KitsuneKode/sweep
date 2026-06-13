import { describe, expect, test } from "bun:test";
import { GuardrailError } from "@kitsunekode/sweep-core/guardrails";
import { ConfigParseError } from "@kitsunekode/sweep-core/config";
import { PlanValidationError } from "@kitsunekode/sweep-core/plan";
import { EXIT, resolveExitCode } from "./errors.js";

describe("exit code mapping", () => {
  test("maps guardrail errors to GUARDRAIL", () => {
    expect(resolveExitCode(new GuardrailError("blocked"))).toBe(EXIT.GUARDRAIL);
    expect(resolveExitCode(new GuardrailError("custom", 4))).toBe(4);
  });

  test("maps plan validation errors to CONFIG_PARSE", () => {
    expect(resolveExitCode(new PlanValidationError("invalid plan"))).toBe(EXIT.CONFIG_PARSE);
    expect(resolveExitCode(new ConfigParseError("bad config"))).toBe(EXIT.CONFIG_PARSE);
  });

  test("maps syntax errors to CONFIG_PARSE", () => {
    expect(resolveExitCode(new SyntaxError("bad json"))).toBe(EXIT.CONFIG_PARSE);
  });

  test("maps unknown errors to FAILURE", () => {
    expect(resolveExitCode(new Error("boom"))).toBe(EXIT.FAILURE);
    expect(resolveExitCode("nope")).toBe(EXIT.FAILURE);
  });
});
