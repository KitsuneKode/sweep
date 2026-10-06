import { SCAN_RESOURCE_PROFILES } from "@kitsunekode/sweep-protocol";
import type {
  ScanCandidate,
  ScanCompletedEvent,
  ScanEntry,
  ScanResult,
  FilesystemIdentity,
} from "@kitsunekode/sweep-protocol";
import { hasCanonicalPathSpelling, isPathWithinRoot, isSameResolvedPath } from "./guardrails.js";
import { PlanValidationError, validateScanEvent } from "./plan.js";
import type { ScanHooks } from "./scanner.js";
import { ResourceBudget, candidateFieldChars, checkedBytes } from "./resource-budget.js";
import { sameFilesystemIdentity } from "./filesystem-identity.js";

// Progress/warning events carry no candidates, so the per-line byte cap is
// the only bound on their count - a hostile engine could emit millions and
// pin the host in JSON.parse. 16ms-cadence heartbeats over ~4.5 hours of
// continuous scanning would reach this cap; no real scan gets close.
const MAX_AUXILIARY_EVENTS = 1_000_000;

function entryFrom(candidate: ScanCandidate): ScanEntry {
  return {
    identity: candidate.identity,
    path: candidate.path,
    name: candidate.name,
    estimatedBytes: candidate.estimatedBytes,
    ...(candidate.bytesKnown === undefined ? {} : { bytesKnown: candidate.bytesKnown }),
    ...(candidate.modifiedMs === undefined ? {} : { modifiedMs: candidate.modifiedMs }),
    isSymlink: candidate.isSymlink,
    entryType: candidate.entryType,
  };
}

/** Validate the native stream before allowing it to influence UI or plans. */
export class RustScanStream {
  private started = false;
  private targetIdentity: FilesystemIdentity | undefined;
  private summary: ScanCompletedEvent["summary"] | null = null;
  private readonly candidates = new Map<string, ScanCandidate>();
  private readonly ids = new Set<string>();
  private readonly sized = new Set<string>();
  private readonly budget: ResourceBudget;
  private auxiliaryEvents = 0;

  constructor(
    private readonly target: string,
    private readonly hooks: ScanHooks = {},
    private readonly exact = false,
  ) {
    this.budget = new ResourceBudget({
      ...SCAN_RESOURCE_PROFILES[hooks.resourceProfile ?? "balanced"],
      ...hooks.limits,
    });
  }

  push(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new PlanValidationError("Invalid scan event JSON from engine");
    }
    const event = validateScanEvent(value);
    if (this.summary) throw new PlanValidationError("scan event received after scan completed");
    if (event.type === "scan_started") {
      if (this.started) throw new PlanValidationError("duplicate scan_started event");
      if (event.targetDir !== this.target) throw new PlanValidationError("scan target mismatch");
      this.started = true;
      this.targetIdentity = event.targetIdentity;
      this.hooks.onStarted?.(event.targetIdentity);
      return;
    }
    if (!this.started) throw new PlanValidationError("scan event received before scan_started");
    if (
      event.type === "candidate_found" ||
      event.type === "candidate_updated" ||
      event.type === "candidates_found" ||
      event.type === "candidates_updated"
    ) {
      const found = event.type === "candidate_found" || event.type === "candidates_found";
      const candidates =
        event.type === "candidates_found" || event.type === "candidates_updated"
          ? event.candidates
          : [event.candidate];
      for (const candidate of candidates) this.pushCandidate(candidate, found);
    } else if (event.type === "scan_progress" || event.type === "warning") {
      if (++this.auxiliaryEvents > MAX_AUXILIARY_EVENTS) {
        throw new PlanValidationError("engine emitted too many progress events");
      }
      if (event.type === "scan_progress") {
        this.hooks.onProgress?.({
          scannedDirs: event.scannedDirs,
          found: event.found,
          skippedDirs: event.skippedDirs ?? 0,
          ...(event.sizedCount === undefined ? {} : { sizedCount: event.sizedCount }),
          ...(event.currentDir === undefined ? {} : { currentDir: event.currentDir }),
        });
      }
    } else if (event.type === "scan_completed") {
      if (this.sized.size !== this.candidates.size) {
        throw new PlanValidationError("scan incomplete: candidate sizes missing");
      }
      const total = [...this.candidates.values()].reduce(
        (sum, candidate) => checkedBytes(sum, candidate.estimatedBytes),
        0,
      );
      if (
        event.summary.candidateCount !== this.candidates.size ||
        event.summary.estimatedTotalBytes !== total
      ) {
        throw new PlanValidationError("scan completion summary does not match candidates");
      }
      this.summary = event.summary;
    }
  }

  private pushCandidate(candidate: ScanCandidate, found: boolean): void {
    // A path spelling normalize() would rewrite (or a trailing separator,
    // which makes lstat follow a leaf symlink) is never a scanner product.
    if (!hasCanonicalPathSpelling(candidate.path)) {
      throw new PlanValidationError("scan candidate path is not canonical");
    }
    // Resolved-path equality, not raw `===`: "/t/." and "/t/" spellings of
    // the target itself must not be admitted as deletable candidates.
    if (
      !isPathWithinRoot(candidate.path, this.target) ||
      isSameResolvedPath(candidate.path, this.target)
    ) {
      throw new PlanValidationError("scan candidate outside target");
    }
    const prior = this.candidates.get(candidate.path);
    if (found) {
      if (prior || this.ids.has(candidate.id)) {
        throw new PlanValidationError("duplicate scan candidate");
      }
      this.budget.candidate(candidate.path, candidateFieldChars(candidate));
      this.ids.add(candidate.id);
      this.candidates.set(candidate.path, candidate);
      this.hooks.onEntry?.(entryFrom(candidate));
      return;
    }
    if (
      !prior ||
      prior.id !== candidate.id ||
      prior.name !== candidate.name ||
      prior.entryType !== candidate.entryType ||
      prior.isSymlink !== candidate.isSymlink ||
      ((prior.identity !== undefined || candidate.identity !== undefined) &&
        !sameFilesystemIdentity(prior.identity, candidate.identity))
    ) {
      throw new PlanValidationError("scan candidate update does not match discovery");
    }
    // The contract is exactly one sizing update per found candidate - a
    // second update for the same id is a protocol violation, not a merge.
    if (this.sized.has(candidate.id)) {
      throw new PlanValidationError("duplicate scan candidate update");
    }
    this.candidates.set(candidate.path, candidate);
    this.sized.add(candidate.id);
    this.hooks.onEntrySized?.(entryFrom(candidate));
  }

  finish(): ScanResult {
    if (!this.summary)
      throw new PlanValidationError("scan incomplete: scan_completed event missing");
    return {
      targetIdentity: this.targetIdentity,
      entries: [...this.candidates.values()].map(entryFrom),
      estimatedTotalBytes: this.summary.estimatedTotalBytes,
      scannedDirs: this.summary.scannedDirs,
      skippedDirs: this.summary.skippedDirs ?? 0,
      exact: this.summary.exact ?? this.exact,
    };
  }
}
