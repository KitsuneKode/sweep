import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { assertPlanResources } from "./resource-budget.js";
import type { ApplyReport, ScanCandidate, ScanEvent, ScanPlan } from "@kitsunekode/sweep-protocol";
import {
  APPLY_REPORT_SCHEMA,
  SCAN_PLAN_SCHEMA,
  PROTOCOL_SHARED_SCHEMA,
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
    ajvInstance.addSchema(PROTOCOL_SHARED_SCHEMA);
  }
  return ajvInstance;
}

function getValidator(): ValidateFunction {
  if (!validateScanPlan) {
    validateScanPlan = getAjv().compile(SCAN_PLAN_SCHEMA);
  }
  return validateScanPlan;
}

/**
 * Trigger the ScanPlan schema compile. Callers that spawn the engine can run
 * this while the subprocess works, hiding the ~100ms cold-compile under the
 * scan instead of paying it after stdout arrives.
 */
export function warmPlanValidator(): void {
  getValidator();
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
    assertPlanResources(value as ScanPlan);
    return value as ScanPlan;
  }

  throw new PlanValidationError(`Invalid scan plan: ${formatValidationErrors(validator.errors)}`);
}

/**
 * Validate an engine-produced apply report. `SWEEP_ENGINE_PATH` lets the
 * subprocess binary be user-supplied, so its stdout is untrusted input - a
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
 * Structural check for one scan event. The schema is also enforced by
 * `scan-event.schema.json`, but AJV compiles that schema lazily - ~100ms of
 * cold compile that used to stall the first streamed row of every Rust scan.
 * Stream events are on the hot path, so they validate by hand; plan files
 * keep the full AJV validator since they are one-shot reads.
 */
export function validateScanEvent(value: unknown): ScanEvent {
  const fail = (detail: string): never => {
    throw new PlanValidationError(`Invalid scan event from engine: ${detail}`);
  };
  if (typeof value !== "object" || value === null) fail("not an object");
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string") fail("missing type");

  const candidateOk = (candidate: unknown): candidate is ScanCandidate => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const c = candidate as Record<string, unknown>;
    return (
      typeof c.id === "string" &&
      typeof c.path === "string" &&
      typeof c.name === "string" &&
      typeof c.estimatedBytes === "number" &&
      Number.isSafeInteger(c.estimatedBytes) &&
      c.estimatedBytes >= 0 &&
      (c.bytesKnown === undefined || typeof c.bytesKnown === "boolean") &&
      (c.modifiedMs === undefined ||
        (typeof c.modifiedMs === "number" &&
          Number.isSafeInteger(c.modifiedMs) &&
          c.modifiedMs >= 0)) &&
      typeof c.isSymlink === "boolean" &&
      (c.entryType === "file" || c.entryType === "directory" || c.entryType === "symlink") &&
      typeof c.kind === "string" &&
      (c.riskTier === "safe" ||
        c.riskTier === "caution" ||
        c.riskTier === "dangerous" ||
        c.riskTier === "blocked") &&
      Array.isArray(c.reasons) &&
      c.reasons.every((reason) => typeof reason === "string") &&
      typeof c.selectedByDefault === "boolean"
    );
  };

  const uint = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

  switch (event.type) {
    case "scan_started":
      if (typeof event.targetDir !== "string") fail("scan_started.targetDir");
      break;
    case "candidate_found":
    case "candidate_updated":
      if (!candidateOk(event.candidate)) fail(`${event.type}.candidate`);
      break;
    case "candidates_found":
    case "candidates_updated": {
      if (!Array.isArray(event.candidates)) fail(`${event.type}.candidates`);
      for (const candidate of event.candidates as unknown[]) {
        if (!candidateOk(candidate)) fail(`${event.type}.candidates[]`);
      }
      break;
    }
    case "scan_progress":
      if (!uint(event.scannedDirs) || !uint(event.found)) fail("scan_progress counters");
      if (event.skippedDirs !== undefined && !uint(event.skippedDirs)) {
        fail("scan_progress.skippedDirs");
      }
      if (event.sizedCount !== undefined && !uint(event.sizedCount)) {
        fail("scan_progress.sizedCount");
      }
      if (event.currentDir !== undefined && typeof event.currentDir !== "string") {
        fail("scan_progress.currentDir");
      }
      break;
    case "warning":
      if (typeof event.message !== "string") fail("warning.message");
      break;
    case "scan_completed": {
      const summary = event.summary;
      if (typeof summary !== "object" || summary === null) fail("scan_completed.summary");
      const s = summary as Record<string, unknown>;
      if (!uint(s.candidateCount) || !uint(s.estimatedTotalBytes) || !uint(s.scannedDirs)) {
        fail("scan_completed.summary counters");
      }
      break;
    }
    default:
      fail(`unknown type ${event.type}`);
  }
  return event as unknown as ScanEvent;
}

/** Bound raw bytes as well as semantic candidate/path counts after parsing. */
const MAX_PLAN_FILE_BYTES = 64 * 1024 * 1024;

export function loadPlan(planPath: string): ScanPlan {
  let handle: number;
  try {
    handle = openSync(planPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new PlanValidationError(
      `Plan file not found or cannot be opened: ${sanitizeTerminalText(planPath)}`,
    );
  }
  let raw: string;
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile())
      throw new PlanValidationError(`Plan path is not a file: ${sanitizeTerminalText(planPath)}`);
    if (stat.size > MAX_PLAN_FILE_BYTES)
      throw new PlanValidationError("Plan file exceeds the 64 MB limit");
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_PLAN_FILE_BYTES + 1 - bytes));
      const n = readSync(handle, chunk, 0, chunk.length, null);
      if (n === 0) break;
      bytes += n;
      if (bytes > MAX_PLAN_FILE_BYTES)
        throw new PlanValidationError("Plan file exceeds the 64 MB limit");
      chunks.push(chunk.subarray(0, n));
    }
    raw = Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    closeSync(handle);
  }
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
