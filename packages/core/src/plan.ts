import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { existsSync, readFileSync } from "node:fs";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import { SCAN_PLAN_SCHEMA } from "@kitsunekode/sweep-protocol";
import { GuardrailError } from "./guardrails.js";

export class PlanValidationError extends Error {
  readonly code = 3;

  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

let validateScanPlan: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (!validateScanPlan) {
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    validateScanPlan = ajv.compile(SCAN_PLAN_SCHEMA);
  }
  return validateScanPlan;
}

function formatValidationErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "unknown validation error";
  return errors
    .map((error) => {
      const path = error.instancePath || "/";
      return `${path}: ${error.message ?? "invalid"}`;
    })
    .join("; ");
}

/** Validate an unknown value against the ScanPlan JSON Schema. */
export function validatePlan(value: unknown): ScanPlan {
  const validator = getValidator();
  if (validator(value)) {
    return value as ScanPlan;
  }

  throw new PlanValidationError(`Invalid scan plan: ${formatValidationErrors(validator.errors)}`);
}

export function loadPlan(planPath: string): ScanPlan {
  if (!existsSync(planPath)) {
    throw new GuardrailError(`Plan file not found: ${planPath}`, 4);
  }

  const raw = readFileSync(planPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) throw err;
    throw new PlanValidationError(
      `Invalid scan plan JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return validatePlan(parsed);
}

export function getSelectedBytes(plan: ScanPlan): number {
  const selectedIds = new Set(plan.selectedCandidateIds);
  return plan.candidates
    .filter((candidate) => selectedIds.has(candidate.id))
    .reduce((sum, candidate) => sum + candidate.estimatedBytes, 0);
}
