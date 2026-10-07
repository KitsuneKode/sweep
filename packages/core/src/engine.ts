import type {
  ApplyOutcome,
  ApplyReport,
  CleanResult,
  PathFailure,
  ScanCandidate,
  ScanEntry,
  ScanPlan,
  ScanResult,
  SelectionPolicy,
  SweepConfig,
} from "@kitsunekode/sweep-protocol";
import { setImmediate } from "node:timers/promises";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { assertPlanResources, checkedBytes, ResourceBudget } from "./resource-budget.js";
import { PROTOCOL_VERSION } from "@kitsunekode/sweep-protocol";
import { clean, deduplicateNestedEntries, dedupeKey } from "./cleaner.js";
import type { ScanHooks } from "./scanner.js";
import { scan, apparentSizeDetailed, exactSizeDetailed } from "./scanner.js";
import { mapPool } from "./async-pool.js";
import { buildPlan, resolveSelectedCandidates, revalidateCandidates } from "./planner.js";
import {
  GuardrailError,
  ApplyRefusedError,
  assertSafeCwd,
  assertSizeLimit,
  pathUsesProcessRelativeRoot,
} from "./guardrails.js";
import { applyPlanViaRust, type EngineBackend } from "./rust-engine.js";
import { readFilesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity.js";

function assertApplyTarget(target: string): void {
  assertSafeCwd(target);
  if (pathUsesProcessRelativeRoot(target)) {
    throw new GuardrailError("plan target resolves through a process-relative path");
  }
  const meta = lstatSync(target);
  if (meta.isSymbolicLink() || !meta.isDirectory()) {
    throw new GuardrailError("plan target is not a real directory");
  }
}

function assertPlanRootIdentity(plan: ScanPlan): void {
  const current = readFilesystemIdentity(plan.targetDir);
  if (!current) {
    throw new GuardrailError(
      "Filesystem root identity is unavailable; apply is disabled on this filesystem. Rescanning cannot establish a stable identity.",
    );
  }
  if (!sameFilesystemIdentity(plan.targetIdentity, current)) {
    throw new GuardrailError(
      "Plan root identity is missing or changed since scan; scan again before applying",
    );
  }
}

export interface ScanToPlanOptions extends ScanHooks {
  exact?: boolean;
  selectionPolicy?: SelectionPolicy;
}

export interface ScanToPlanResult {
  result: ScanResult;
  plan: ScanPlan;
}

export interface ApplyPlanResult {
  report: ApplyReport;
  cleanResult: CleanResult;
  selected: ScanCandidate[];
  ready: ScanEntry[];
  revalidationFailures: PathFailure[];
  /** True when cancellation stopped scheduling - some candidates were never attempted. */
  interrupted: boolean;
}

export function scanToPlan(
  targetDir: string,
  config: SweepConfig,
  options: ScanToPlanOptions = {},
): Promise<ScanToPlanResult> {
  return scan(targetDir, config, options.exact ?? false, options).then((result) => {
    if (options.signal?.aborted) throw new GuardrailError("Scan interrupted", 1);
    return { result, plan: buildPlan(targetDir, result, options.selectionPolicy) };
  });
}

export interface ApplyPlanOptions {
  /** Refreshed observation ceiling, checked before the first removal. */
  maxSizeGB?: number | null;
  forceLarge?: boolean;
  onPrepare?: (
    entry: ScanEntry,
    completed: number,
    total: number,
    phase: "validating" | "sizing",
  ) => void;
  /** Path about to be removed or moved, before the slow call. */
  onBegin?: (entry: ScanEntry) => void;
  onDeleted?: (entry: ScanEntry) => void;
  onActivity?: (entry: ScanEntry, removedEntries: number) => void;
  /** JS engine: checked before each delete; true stops scheduling new work. */
  isCancelled?: () => boolean;
  /** Stop scheduling removals and drain the native final report. */
  signal?: AbortSignal;
  /** Move candidates into this dir instead of deleting (JS engine only). */
  trashDir?: string;
  /** Scan root used to lay out `trashDir`; required with `trashDir`. */
  trashRoot?: string;
}

export async function applyPlan(
  plan: ScanPlan,
  options: ApplyPlanOptions = {},
): Promise<ApplyPlanResult> {
  // A plan file is untrusted input: refuse unknown protocol versions instead
  // of interpreting a future/past schema with this engine's semantics.
  // Mirrors the Rust engine's apply_plan check.
  if (plan.protocolVersion !== PROTOCOL_VERSION) {
    throw new GuardrailError(
      `unsupported plan protocol version "${plan.protocolVersion}" (expected "${PROTOCOL_VERSION}")`,
    );
  }
  assertApplyTarget(plan.targetDir);
  assertPlanResources(plan);
  // A NaN/Infinity ceiling would silently disable the size preflight
  // entirely (JSON.stringify turns it into null) - reject it loudly.
  if (
    options.maxSizeGB !== undefined &&
    options.maxSizeGB !== null &&
    (!Number.isFinite(options.maxSizeGB) ||
      options.maxSizeGB < 0 ||
      options.maxSizeGB > Number.MAX_SAFE_INTEGER / 1024 ** 3)
  ) {
    throw new GuardrailError(`invalid maxSizeGB: ${options.maxSizeGB}`);
  }
  const selected = resolveSelectedCandidates(plan);

  if (selected.length === 0) {
    return emptyApplyPlanResult(plan);
  }
  assertPlanRootIdentity(plan);

  // Plans are untrusted input: every selected path is revalidated per entry
  // (containment, target-root, VCS segments, symlink/type state), matching the
  // Rust engine's apply_plan. Forged entries become per-path failures in the
  // report instead of aborting the whole apply.
  const isCancelled = () =>
    (options.signal?.aborted ?? false) || (options.isCancelled?.() ?? false);
  // Bound synchronous validation work between event-loop yields. Recheck the
  // root in each batch; never reuse a preflight check at the removal boundary.
  const ready: ScanEntry[] = [];
  const revalidationFailures: PathFailure[] = [];
  for (let offset = 0; offset < selected.length && !isCancelled(); offset += 128) {
    await setImmediate();
    if (isCancelled()) break;
    options.onPrepare?.(selected[offset]!, offset, selected.length, "validating");
    const batch = revalidateCandidates(
      selected.slice(offset, offset + 128),
      plan.targetDir,
      isCancelled,
    );
    ready.push(...batch.ready);
    revalidationFailures.push(...batch.failedPaths);
  }
  // Canonical aliases can stop resolving after their parent is removed.
  // Freeze receipt keys before any sizing callback or destructive operation.
  const receiptKeys = new Map<string, string>();
  for (let i = 0; i < selected.length; i++) {
    if (i % 128 === 0) await setImmediate();
    const candidate = selected[i]!;
    receiptKeys.set(candidate.path, dedupeKey(candidate.path));
  }
  const frozenKey = (path: string) => receiptKeys.get(path) ?? dedupeKey(path);
  // Dedupe up front so `interrupted` compares against the real work set -
  // entries deduped away are never attempted and must not read as skipped.
  const workSet = deduplicateNestedEntries(ready);
  if (
    options.maxSizeGB !== undefined &&
    options.maxSizeGB !== null &&
    !options.forceLarge &&
    !options.signal?.aborted
  ) {
    const budget = new ResourceBudget();
    let prepared = 0;
    const sizes = await mapPool(workSet, 8, async (entry) => {
      options.onPrepare?.(entry, prepared, workSet.length, "sizing");
      const size = await (plan.summary.exact ? exactSizeDetailed : apparentSizeDetailed)(
        entry.path,
        options.signal,
        budget,
      );
      if (!size.complete && !options.signal?.aborted)
        throw new ApplyRefusedError(
          "Cannot verify current size; rescan or explicitly use --force-large --yes. Nothing removed.",
          "current_size_unavailable",
        );
      prepared++;
      options.onPrepare?.(entry, prepared, workSet.length, "sizing");
      return size.bytes;
    });
    if (!isCancelled())
      assertSizeLimit(
        sizes.reduce((sum, size) => checkedBytes(sum, size), 0),
        options.maxSizeGB,
        false,
      );
  }
  const cleanResult = await clean(workSet, {
    onBegin: (entry) => {
      options.onBegin?.(entry);
    },
    onProgress: (entry, _index, _total, succeeded) => {
      // Progress fires for failed entries too - only real removals count
      // toward the freed-bytes line.
      if (succeeded) options.onDeleted?.(entry);
    },
    isCancelled: () => (options.signal?.aborted ?? false) || (options.isCancelled?.() ?? false),
    trashDir: options.trashDir,
    trashRoot: options.trashRoot,
    containmentRoot: plan.targetDir,
    containmentIdentity: plan.targetIdentity,
  });
  const allFailures = [...revalidationFailures, ...cleanResult.failedPaths];
  // Rust parity: `interrupted` is whether the cancel flag was observed at
  // all - including a signal already aborted before revalidation, where
  // workSet is empty and the residual comparison alone reads false.
  const interrupted =
    (options.signal?.aborted ?? false) ||
    (options.isCancelled?.() ?? false) ||
    cleanResult.deleted.length + cleanResult.failedPaths.length < workSet.length;

  const firstByPath = new Map(
    workSet.map((entry) => [frozenKey(entry.path), entry as ScanCandidate]),
  );
  // Candidates revalidation never reached (cancelled mid-loop) must report
  // "unattempted", not "failed": the tail has no failedPaths entry, and
  // counting it would disagree with failedCount (Rust parity).
  const readySet = new Set(ready);
  const revalidationFailureKeys = new Set(
    revalidationFailures.map((failure) => frozenKey(failure.path)),
  );
  const failedIds = new Set(
    selected
      .filter(
        (candidate) =>
          !readySet.has(candidate) && revalidationFailureKeys.has(frozenKey(candidate.path)),
      )
      .map((candidate) => candidate.id),
  );
  for (const failure of cleanResult.failedPaths) {
    const candidate = firstByPath.get(frozenKey(failure.path));
    if (candidate) failedIds.add(candidate.id);
  }
  const removed = new Map<string, string>();
  const removedDirs = new Map<string, string>();
  for (const entry of cleanResult.deleted) {
    const key = frozenKey(entry.path);
    const id = firstByPath.get(key)!.id;
    removed.set(key, id);
    if (entry.entryType === "directory" && !entry.isSymlink) removedDirs.set(key, id);
  }
  const outcomes: ApplyOutcome[] = selected.map((candidate) => {
    if (failedIds.has(candidate.id)) return { candidateId: candidate.id, status: "failed" };
    const key = frozenKey(candidate.path);
    let coveredBy = removed.get(key);
    if (coveredBy === candidate.id) return { candidateId: candidate.id, status: "deleted" };
    let parent = dirname(key);
    while (!coveredBy && parent !== key) {
      coveredBy = removedDirs.get(parent);
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return coveredBy
      ? { candidateId: candidate.id, status: "covered", coveredBy }
      : { candidateId: candidate.id, status: "unattempted" };
  });
  return {
    report: {
      protocolVersion: PROTOCOL_VERSION,
      targetDir: plan.targetDir,
      selectedCandidateIds: selected.map((candidate) => candidate.id),
      deletedCount: cleanResult.deleted.length,
      failedCount: allFailures.length,
      totalBytesFreed: cleanResult.totalBytesFreed,
      failedPaths: allFailures,
      outcomes,
      interrupted,
      ...(cleanResult.trashMoves ? { trashMoves: cleanResult.trashMoves } : {}),
    },
    cleanResult,
    selected,
    ready,
    revalidationFailures,
    interrupted,
  };
}

function emptyApplyPlanResult(plan: ScanPlan): ApplyPlanResult {
  return {
    report: {
      protocolVersion: PROTOCOL_VERSION,
      targetDir: plan.targetDir,
      selectedCandidateIds: [],
      outcomes: [],
      interrupted: false,
      deletedCount: 0,
      failedCount: 0,
      totalBytesFreed: 0,
      failedPaths: [],
    },
    cleanResult: {
      deleted: [],
      failedPaths: [],
      totalBytesFreed: 0,
      durationMs: 0,
    },
    selected: [],
    ready: [],
    revalidationFailures: [],
    interrupted: false,
  };
}

export async function applyPlanWithBackend(
  plan: ScanPlan,
  engine: EngineBackend,
  options: ApplyPlanOptions = {},
): Promise<ApplyPlanResult> {
  if (engine !== "rust") {
    return applyPlan(plan, options);
  }

  // Trash is JS-only - a rust call that silently ignored trashDir would
  // delete permanently when the caller asked for a move. Fail loudly.
  if (options.trashDir || options.trashRoot) {
    throw new GuardrailError("trash mode is not supported by the Rust engine");
  }

  assertApplyTarget(plan.targetDir);
  assertPlanResources(plan);
  if (
    options.maxSizeGB !== undefined &&
    options.maxSizeGB !== null &&
    (!Number.isFinite(options.maxSizeGB) ||
      options.maxSizeGB < 0 ||
      options.maxSizeGB > Number.MAX_SAFE_INTEGER / 1024 ** 3)
  ) {
    throw new GuardrailError(`invalid maxSizeGB: ${options.maxSizeGB}`);
  }
  const selected = resolveSelectedCandidates(plan);
  if (selected.length === 0) {
    return emptyApplyPlanResult(plan);
  }
  assertPlanRootIdentity(plan);

  // The Rust engine revalidates per entry itself (containment, protected
  // paths, symlink/type state); forged candidates come back as failures.
  const startedAt = performance.now();
  const byId = new Map(selected.map((candidate) => [candidate.id, candidate]));
  const report = await applyPlanViaRust(
    plan,
    options.signal,
    (id) => {
      const candidate = byId.get(id);
      if (candidate) options.onDeleted?.(candidate);
    },
    options.maxSizeGB === undefined || options.maxSizeGB === null || options.forceLarge
      ? undefined
      : Math.floor(options.maxSizeGB * 1024 ** 3),
    (id) => {
      const candidate = byId.get(id);
      if (candidate) options.onBegin?.(candidate);
    },
    (id, completed, total) => {
      const candidate = byId.get(id);
      if (candidate) options.onPrepare?.(candidate, completed, total, "sizing");
    },
    (id, removedEntries) => {
      const candidate = byId.get(id);
      if (candidate) options.onActivity?.(candidate, removedEntries);
    },
  );
  const deletedIds = new Set(
    report.outcomes
      ?.filter((outcome) => outcome.status === "deleted")
      .map((outcome) => outcome.candidateId),
  );
  const revalidationCodes = new Set<PathFailure["code"]>([
    "missing",
    "changed_symlink_state",
    "changed_entry_type",
    "outside_target",
    "protected_path",
  ]);
  const revalidationFailures = report.failedPaths.filter((failure) =>
    revalidationCodes.has(failure.code),
  );
  const deleted = selected.filter((candidate) => deletedIds.has(candidate.id));
  const failedRevalidationPaths = new Set(revalidationFailures.map((failure) => failure.path));
  const ready = selected.filter((candidate) => !failedRevalidationPaths.has(candidate.path));

  const cleanResult: CleanResult = {
    deleted,
    failedPaths: report.failedPaths,
    totalBytesFreed: report.totalBytesFreed,
    durationMs: Math.round(performance.now() - startedAt),
  };

  return {
    report,
    cleanResult,
    selected,
    ready,
    revalidationFailures,
    interrupted: report.interrupted ?? false,
  };
}
