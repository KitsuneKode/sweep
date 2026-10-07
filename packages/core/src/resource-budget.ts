import {
  DEFAULT_SCAN_LIMITS,
  type ScanCandidate,
  type ScanLimits,
  type ScanPlan,
} from "@kitsunekode/sweep-protocol";
import { GuardrailError } from "./guardrails.js";
import { SYMLINK_ALIAS_REASON, WORKSPACE_STUB_REASON } from "./candidate-insights.js";

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
    maxCombinedBytes: 0,
  };
  private failure: ResourceLimitError | undefined;
  private sizingIds = 0;
  private sizingDirs = 0;
  private sizingPaths = 0;
  private sizingBytes = 0;

  /** Live totals across all sizing jobs; saturation never poisons discovery. */
  sizingIdentity(): boolean {
    if (
      this.sizingIds >= this.limits.maxIdentities ||
      this.sizingBytes + 128 > this.limits.maxRetainedBytes ||
      this.used.maxRetainedBytes + this.sizingBytes + 128 > this.limits.maxCombinedBytes
    )
      return false;
    this.sizingIds++;
    this.sizingBytes += 128;
    return true;
  }

  releaseSizingIdentities(count: number): void {
    this.sizingIds -= count;
    this.sizingBytes -= count * 128;
  }

  sizingDirectory(path: string | Buffer): boolean {
    const bytes = Buffer.isBuffer(path) ? path.length : Buffer.byteLength(path);
    const retained = 128 + bytes * 4;
    if (
      this.sizingDirs >= this.limits.maxQueuedDirs ||
      this.sizingPaths + bytes > this.limits.maxPathBytes ||
      this.sizingBytes + retained > this.limits.maxRetainedBytes ||
      this.used.maxRetainedBytes + this.sizingBytes + retained > this.limits.maxCombinedBytes
    )
      return false;
    this.sizingDirs++;
    this.sizingPaths += bytes;
    this.sizingBytes += retained;
    return true;
  }

  releaseSizingDirectory(path: string | Buffer): void {
    const bytes = Buffer.isBuffer(path) ? path.length : Buffer.byteLength(path);
    this.sizingDirs--;
    this.sizingPaths -= bytes;
    this.sizingBytes -= 128 + bytes * 4;
  }

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
    if (
      resource === "maxRetainedBytes" &&
      total + this.sizingBytes > this.limits.maxCombinedBytes
    ) {
      this.failure = new ResourceLimitError("maxCombinedBytes");
      throw this.failure;
    }
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

  candidate(path: string, extraChars = 0): void {
    this.charge("maxCandidates", 1);
    // extraChars covers the OTHER retained string fields (id, name, kind,
    // reasons) at worst-case UTF-32 width - the path alone undercounts what
    // actually stays in memory per candidate.
    this.path(path, 1024 + extraChars * 4);
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

/** Characters retained per candidate beyond the path: id, name, kind, reasons. */
export function candidateFieldChars(candidate: ScanCandidate): number {
  return (
    candidate.id.length +
    candidate.name.length +
    candidate.kind.length +
    (candidate.identity
      ? candidate.identity.platform.length +
        candidate.identity.device.length +
        candidate.identity.inode.length
      : 0) +
    candidate.reasons.reduce((sum, reason) => sum + reason.length, 0)
  );
}

/** Reserve reasons added after sizing/enrichment so a completed scan fits its plan. */
export function discoveryCandidateFieldChars(candidate: ScanCandidate): number {
  return (
    candidateFieldChars(candidate) +
    (candidate.isSymlink && !candidate.reasons.includes(SYMLINK_ALIAS_REASON)
      ? SYMLINK_ALIAS_REASON.length
      : 0) +
    (candidate.name === "node_modules" &&
    candidate.entryType === "directory" &&
    !candidate.reasons.includes(WORKSPACE_STUB_REASON)
      ? WORKSPACE_STUB_REASON.length
      : 0)
  );
}

/** Validate logical bounds and byte totals before any destructive operation. */
export function assertPlanResources(plan: ScanPlan): void {
  const budget = new ResourceBudget();
  let total = 0;
  if (plan.selectedCandidateIds.length > budget.limits.maxCandidates)
    throw new ResourceLimitError("maxCandidates");
  checkedBytes(0, plan.summary.estimatedTotalBytes);
  for (const candidate of plan.candidates) {
    budget.candidate(candidate.path, candidateFieldChars(candidate));
    total = checkedBytes(total, candidate.estimatedBytes);
  }
}
