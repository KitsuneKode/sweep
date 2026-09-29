import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { readFileSync, statSync } from "node:fs";
import type { ApplyReport, ScanPlan } from "@kitsunekode/sweep-protocol";
import {
  APPLY_REPORT_SCHEMA,
  SCAN_PLAN_SCHEMA,
  sanitizeTerminalText,
} from "@kitsunekode/sweep-protocol";

export class PlanValidationError extends Error {
  readonly code = 3;

  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

let ajvInstance: Ajv2020 | undefined;
let validateScanPlan: ValidateFunction | undefined;
let validateApplyReportFn: ValidateFunction | undefined;

function getAjv(): Ajv2020 {
  if (!ajvInstance) {
    ajvInstance = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  }
  return ajvInstance;
}

function getValidator(): ValidateFunction {
  if (!validateScanPlan) {
    validateScanPlan = getAjv().compile(SCAN_PLAN_SCHEMA);
  }
  return validateScanPlan;
}

function getApplyReportValidator(): ValidateFunction {
  if (!validateApplyReportFn) {
    validateApplyReportFn = getAjv().compile(APPLY_REPORT_SCHEMA);
  }
  return validateApplyReportFn;
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

/**
 * Validate an engine-produced apply report. `SWEEP_ENGINE_PATH` lets the
 * subprocess binary be user-supplied, so its stdout is untrusted input — a
 * malformed report must fail loudly instead of silently passing a fake
 * deletedCount to the caller.
 */
export function validateApplyReport(value: unknown): ApplyReport {
  const validator = getApplyReportValidator();
  if (validator(value)) {
    return value as ApplyReport;
  }

  throw new PlanValidationError(
    `Invalid apply report from engine: ${formatValidationErrors(validator.errors)}`,
  );
}

/**
 * Plans embed one JSON object per candidate — a few hundred bytes each.
 * 256 MB is far past any legitimate plan (≈1M candidates) and stops a
 * hostile or corrupt file from pinning the process in JSON.parse.
 */
const MAX_PLAN_FILE_BYTES = 256 * 1024 * 1024;

export function loadPlan(planPath: string): ScanPlan {
  let stat;
  try {
    stat = statSync(planPath);
  } catch {
    throw new PlanValidationError(`Plan file not found: ${sanitizeTerminalText(planPath)}`);
  }
  if (!stat.isFile()) {
    throw new PlanValidationError(`Plan path is not a file: ${sanitizeTerminalText(planPath)}`);
  }
  if (stat.size > MAX_PLAN_FILE_BYTES) {
    throw new PlanValidationError(
      `Plan file exceeds the 256 MB limit: ${sanitizeTerminalText(planPath)}`,
    );
  }

  const raw = readFileSync(planPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
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
