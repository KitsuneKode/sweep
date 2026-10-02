import { DEFAULT_SCAN_LIMITS, type ScanLimits, type ScanPlan } from "@kitsunekode/sweep-protocol";
import { GuardrailError } from "./guardrails.js";

export class ResourceLimitError extends GuardrailError {
  constructor(resource: string) {
    super(
      `Scan resource limit exceeded (${resource}); scan is incomplete. Scan a smaller subtree.`,
    );
    this.name = "ResourceLimitError";
  }
}

/** Byte counts crossing the JS/native boundary must retain integer precision. */
export function checkedBytes(a: number, b: number): number {
  const total = a + b;
  if (
    !Number.isSafeInteger(a) ||
    a < 0 ||
    !Number.isSafeInteger(b) ||
    b < 0 ||
    !Number.isSafeInteger(total)
  )
    throw new ResourceLimitError("byte counter overflow");
  return total;
}

/** Conservative cumulative charges. This is not process RSS accounting. */
export class ResourceBudget {
  readonly limits: Readonly<ScanLimits>;
  private readonly used: Record<keyof ScanLimits, number> = {
    maxCandidates: 0,
    maxDirectories: 0,
    maxQueuedDirs: 0,
    maxIdentities: 0,
    maxPathBytes: 0,
    maxRetainedBytes: 0,
  };
  private failure: ResourceLimitError | undefined;

  constructor(limits: Partial<ScanLimits> = {}) {
    this.limits = Object.freeze({ ...DEFAULT_SCAN_LIMITS, ...limits });
    for (const [name, value] of Object.entries(this.limits)) {
      if (
        !Object.hasOwn(DEFAULT_SCAN_LIMITS, name) ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > 0xffff_ffff
      )
        throw new Error(`Invalid scan limit ${name}: expected a positive 32-bit integer`);
    }
  }

  check(): void {
    if (this.failure) throw this.failure;
  }

  private charge(resource: keyof ScanLimits, amount: number): void {
    this.check();
    const total = checkedBytes(this.used[resource], amount);
    if (total > this.limits[resource]) {
      this.failure = new ResourceLimitError(resource);
      throw this.failure;
    }
    this.used[resource] = total;
  }

  private path(path: string | Buffer, overhead: number): void {
    const bytes = Buffer.isBuffer(path) ? path.length : Buffer.byteLength(path);
    this.charge("maxPathBytes", bytes);
    this.charge("maxRetainedBytes", bytes * 4 + overhead);
  }

  candidate(path: string): void {
    this.charge("maxCandidates", 1);
    this.path(path, 1024);
  }

  directory(path: string | Buffer): void {
    this.charge("maxDirectories", 1);
    this.charge("maxQueuedDirs", 1);
    this.path(path, 128);
  }

  dequeueDirectory(): void {
    this.used.maxQueuedDirs--;
  }

  identity(): void {
    this.charge("maxIdentities", 1);
    this.charge("maxRetainedBytes", 128);
  }
}

/** Validate logical bounds and byte totals before any destructive operation. */
export function assertPlanResources(plan: ScanPlan): void {
  const budget = new ResourceBudget();
  let total = 0;
  if (plan.selectedCandidateIds.length > budget.limits.maxCandidates)
    throw new ResourceLimitError("maxCandidates");
  checkedBytes(0, plan.summary.estimatedTotalBytes);
  for (const candidate of plan.candidates) {
    budget.candidate(candidate.path);
    total = checkedBytes(total, candidate.estimatedBytes);
  }
}
