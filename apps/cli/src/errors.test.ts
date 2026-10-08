import { describe, expect, test } from "bun:test";
import {
  ApplyOutcomeUnknownError,
  ApplyRefusedError,
  GuardrailError,
} from "@kitsunekode/sweep-core/guardrails";
import { ConfigParseError } from "@kitsunekode/sweep-core/config";
import { PlanValidationError } from "@kitsunekode/sweep-core/plan";
import { EXIT, resolveExitCode, fatalErrorDocument } from "./errors.js";

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

  test("defines distinct exit codes", () => {
    expect(EXIT.ABORTED).toBe(1);
    expect(EXIT.CONFIG_PARSE).toBe(3);
    expect(EXIT.WARN).toBe(5);
    expect(EXIT.ABORTED).not.toBe(EXIT.WARN);
  });
});

test("automation errors distinguish a proven refusal from uncertain mutation", () => {
  expect(
    fatalErrorDocument(new ApplyRefusedError("over limit", "size_limit_exceeded"), "unknown"),
  ).toMatchObject({
    type: "error",
    code: "size_limit_exceeded",
    exitCode: 2,
    applyOutcome: "not_started",
    retryable: false,
  });
  expect(fatalErrorDocument(new Error("broken native pipe"), "unknown")).toMatchObject({
    code: "failure",
    applyOutcome: "unknown",
  });
  expect(fatalErrorDocument(new Error("bad input"), "not_started")).toMatchObject({
    applyOutcome: "not_started",
  });
  expect(fatalErrorDocument(new ApplyRefusedError("busy", "apply_busy"))).toMatchObject({
    retryable: true,
    applyOutcome: "not_started",
  });
});

test("unknown apply outcomes are failures, never ordinary user aborts", () => {
  const error = new ApplyOutcomeUnknownError("report missing");
  expect(resolveExitCode(error)).toBe(EXIT.FAILURE);
  expect(fatalErrorDocument(error, "not_started")).toMatchObject({
    code: "apply_outcome_unknown",
    exitCode: 4,
    applyOutcome: "unknown",
    retryable: false,
  });
  expect(resolveExitCode(new GuardrailError("unsupported code", 5))).toBe(EXIT.FAILURE);
  expect(resolveExitCode(new GuardrailError("unsupported code", 99))).toBe(EXIT.FAILURE);
});

test("error codes survive separately bundled core constructors", () => {
  const refused = Object.assign(new Error("busy"), {
    name: "ApplyRefusedError",
    applyOutcome: "not_started",
    refusalCode: "apply_busy",
  });
  expect(resolveExitCode(refused)).toBe(EXIT.GUARDRAIL);
  expect(fatalErrorDocument(refused)).toMatchObject({
    exitCode: 2,
    retryable: true,
    applyOutcome: "not_started",
  });
  const unknown = Object.assign(new Error("lost"), {
    name: "ApplyOutcomeUnknownError",
    applyOutcome: "unknown",
  });
  expect(fatalErrorDocument(unknown)).toMatchObject({
    exitCode: 4,
    code: "apply_outcome_unknown",
    retryable: false,
    applyOutcome: "unknown",
  });
});
