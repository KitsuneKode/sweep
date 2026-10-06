import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ApplyOutcome, ApplyReport, ScanPlan } from "@kitsunekode/sweep-protocol";
import { sweepConfigDir } from "./config.js";
import { ApplyRefusedError, GuardrailError } from "./guardrails.js";
import { assertPlanResources } from "./resource-budget.js";
import { resolveSelectedCandidates } from "./planner.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LINE = 64 * 1024;

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const meta = lstatSync(path);
  if (
    !meta.isDirectory() ||
    meta.isSymbolicLink() ||
    (process.getuid && meta.uid !== process.getuid()) ||
    (process.platform !== "win32" && (meta.mode & 0o022) !== 0)
  ) {
    throw new GuardrailError(`Unsafe apply journal directory: ${path}`);
  }
}

function syncDirectory(path: string): void {
  // Windows does not support opening directories through Node's POSIX API.
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written === 0) throw new Error("Short apply journal write");
    offset += written;
  }
}

export interface ApplySession {
  journalPath: string;
  finish(report: ApplyReport): void;
  close(): void;
}

/** All CLI applies sharing a config directory serialize, including overlapping
 * scan roots. Stale locks are never guessed safe: a detached native child may
 * outlive its host. External filesystem writers do not participate in this lock. */
export function beginApplySession(plan: ScanPlan, engine: string, trashDir?: string): ApplySession {
  assertPlanResources(plan);
  const selected = resolveSelectedCandidates(plan);
  const root = sweepConfigDir();
  privateDirectory(root);
  const journals = join(root, "journals");
  privateDirectory(journals);
  const lock = join(root, "apply.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ApplyRefusedError(
        `Another apply or an unresolved crashed session holds the apply lock: ${lock}. Inspect its journal before retrying. Nothing removed by this request.`,
        "apply_busy",
      );
    }
    throw error;
  }
  const ownedLock = lstatSync(lock, { bigint: true });
  const sessionId = randomUUID();
  const journalPath = join(journals, `${Date.now()}-${sessionId}.jsonl`);
  let fd: number | undefined;
  let bytes = 0;
  let finished = false;
  let closed = false;
  const append = (record: unknown) => {
    if (fd === undefined) throw new Error("Apply journal is closed");
    const data = Buffer.from(`${JSON.stringify(record)}\n`);
    if (data.length > MAX_LINE || bytes + data.length > MAX_BYTES) {
      throw new GuardrailError("Apply journal size limit exceeded");
    }
    writeAll(fd, data);
    bytes += data.length;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (fd !== undefined) {
      const handle = fd;
      fd = undefined;
      try {
        closeSync(handle);
      } catch {
        // Keep the lock if closing the journal has an uncertain result.
        return;
      }
    }
    try {
      const current = lstatSync(lock, { bigint: true });
      if (
        current.isSymbolicLink() ||
        current.dev !== ownedLock.dev ||
        current.ino !== ownedLock.ino
      )
        return;
      // Never recursively remove a replaced or occupied lock directory.
      try {
        unlinkSync(join(lock, "owner.json"));
      } catch (error) {
        // Creation can fail before owner.json exists; the owned empty lock
        // must still be released. Other errors leave it for inspection.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      rmdirSync(lock);
    } catch {
      /* Leave an uncertain lock for inspection. */
    }
  };
  try {
    fd = openSync(
      journalPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const owner = openSync(join(lock, "owner.json"), "wx", 0o600);
    try {
      writeAll(
        owner,
        Buffer.from(
          JSON.stringify({ sessionId, pid: process.pid, journalPath, targetDir: plan.targetDir }),
        ),
      );
      fsyncSync(owner);
    } finally {
      closeSync(owner);
    }
    syncDirectory(lock);
    syncDirectory(root);
    append({
      type: "intent",
      version: 1,
      sessionId,
      targetDir: plan.targetDir,
      engine,
      trashDir,
      createdAt: new Date().toISOString(),
    });
    for (const candidate of selected) {
      append({
        type: "candidate",
        candidateId: candidate.id,
        path: candidate.path,
        identity: candidate.identity,
      });
    }
    append({ type: "armed", selectedCount: selected.length });
    fsyncSync(fd);
    syncDirectory(journals);
    return {
      journalPath,
      finish(report) {
        if (finished) throw new Error("Apply journal already completed");
        const known = new Set(selected.map((c) => c.id));
        const seen = new Set<string>();
        if (
          !report.outcomes ||
          report.outcomes.length !== known.size ||
          report.targetDir !== plan.targetDir
        ) {
          throw new Error("Apply report does not account for every journal intent");
        }
        for (const outcome of report.outcomes) {
          if (!known.has(outcome.candidateId) || seen.has(outcome.candidateId))
            throw new Error("Invalid apply journal outcome");
          seen.add(outcome.candidateId);
          append({ type: "outcome", ...outcome });
        }
        for (const move of report.trashMoves ?? []) append({ type: "trash_move", ...move });
        append({
          type: "complete",
          selectedCount: seen.size,
          interrupted: report.interrupted ?? false,
        });
        fsyncSync(fd!);
        finished = true;
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

export interface ApplyLockStatus {
  held: boolean;
  lockPath: string;
  ageMs?: number;
  owner?: { sessionId: string; pid: number; journalPath: string; targetDir: string };
  processStatus?: "running" | "not_found" | "unknown";
  detail?: string;
}

/** A diagnostic observation, never permission to remove a lock. PIDs may be
 * reused and a native child may outlive the host recorded in owner.json. */
export function readApplyLockStatus(): ApplyLockStatus {
  const lockPath = join(sweepConfigDir(), "apply.lock");
  let meta;
  try {
    meta = lstatSync(lockPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { held: false, lockPath };
    return { held: true, lockPath, detail: "Cannot inspect apply lock" };
  }
  const status: ApplyLockStatus = {
    held: true,
    lockPath,
    ageMs: Math.max(0, Date.now() - Number(meta.mtimeMs)),
  };
  if (!meta.isDirectory() || meta.isSymbolicLink())
    return { ...status, detail: "Unsafe apply lock directory" };
  let fd: number | undefined;
  try {
    const ownerPath = join(lockPath, "owner.json");
    const before = lstatSync(ownerPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("unsafe owner file");
    fd = openSync(
      ownerPath,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    const ownerMeta = fstatSync(fd, { bigint: true });
    if (ownerMeta.dev !== before.dev || ownerMeta.ino !== before.ino || ownerMeta.size > 4096n)
      throw new Error("owner file changed or oversized");
    const bytes = Buffer.alloc(Number(ownerMeta.size));
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!n) throw new Error("short owner read");
      offset += n;
    }
    const current = lstatSync(lockPath, { bigint: true });
    if (current.dev !== meta.dev || current.ino !== meta.ino || current.isSymbolicLink())
      throw new Error("lock changed");
    const owner = JSON.parse(bytes.toString("utf8"));
    if (
      typeof owner.sessionId !== "string" ||
      owner.sessionId.length > 64 ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      owner.pid > 0x7fffffff ||
      typeof owner.journalPath !== "string" ||
      !isAbsolute(owner.journalPath) ||
      typeof owner.targetDir !== "string" ||
      !isAbsolute(owner.targetDir)
    )
      throw new Error("invalid owner record");
    status.owner = {
      sessionId: owner.sessionId,
      pid: owner.pid,
      journalPath: owner.journalPath,
      targetDir: owner.targetDir,
    };
    try {
      process.kill(owner.pid, 0);
      status.processStatus = "running";
    } catch (error) {
      status.processStatus =
        (error as NodeJS.ErrnoException).code === "ESRCH" ? "not_found" : "unknown";
    }
    return status;
  } catch {
    return { ...status, detail: "Apply owner record unavailable or invalid" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface RecoveredApplyJournal {
  journalPath: string;
  targetDir: string;
  complete: boolean;
  armed: boolean;
  activeSession?: { pid: number; processStatus: "running" | "not_found" | "unknown" };
  candidates: Array<{
    candidateId: string;
    path: string;
    status: ApplyOutcome["status"] | "unknown";
  }>;
  trashMoves: Array<{ path: string; destination: string }>;
}

/** Read bounded records from one regular pinned handle. Never executes paths,
 * releases locks, restores payloads or retries an operation from a journal. */
export function recoverApplyJournal(path: string): RecoveredApplyJournal {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
    throw new GuardrailError("Journal must be a regular private file");
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const meta = fstatSync(fd, { bigint: true });
    if (
      !meta.isFile() ||
      meta.dev !== before.dev ||
      meta.ino !== before.ino ||
      meta.size > BigInt(MAX_BYTES)
    )
      throw new GuardrailError("Invalid or oversized apply journal");
    let targetDir = "";
    let armed = false;
    let complete = false;
    let count = 0;
    const candidates = new Map<
      string,
      { candidateId: string; path: string; status: ApplyOutcome["status"] | "unknown" }
    >();
    const outcomes = new Map<string, ApplyOutcome["status"]>();
    const trashMoves: RecoveredApplyJournal["trashMoves"] = [];
    const consume = (line: string) => {
      const record: unknown = JSON.parse(line);
      if (!record || typeof record !== "object")
        throw new GuardrailError("Invalid apply journal record");
      const r = record as Record<string, unknown>;
      if (complete) throw new GuardrailError("Records after journal completion");
      if (r.type === "intent") {
        if (
          targetDir ||
          r.version !== 1 ||
          typeof r.targetDir !== "string" ||
          !isAbsolute(r.targetDir)
        )
          throw new GuardrailError("Invalid journal intent");
        targetDir = r.targetDir;
      } else if (r.type === "candidate") {
        if (
          !targetDir ||
          armed ||
          typeof r.candidateId !== "string" ||
          typeof r.path !== "string" ||
          candidates.has(r.candidateId) ||
          candidates.size >= 100_000
        )
          throw new GuardrailError("Invalid journal candidate");
        candidates.set(r.candidateId, {
          candidateId: r.candidateId,
          path: r.path,
          status: "unknown",
        });
      } else if (r.type === "armed") {
        if (!targetDir || armed || r.selectedCount !== candidates.size)
          throw new GuardrailError("Invalid journal admission");
        armed = true;
      } else if (r.type === "outcome") {
        if (
          !armed ||
          typeof r.candidateId !== "string" ||
          !candidates.has(r.candidateId) ||
          outcomes.has(r.candidateId) ||
          !["deleted", "failed", "covered", "unattempted"].includes(String(r.status))
        )
          throw new GuardrailError("Invalid journal outcome");
        outcomes.set(r.candidateId, r.status as ApplyOutcome["status"]);
      } else if (r.type === "trash_move") {
        if (
          !armed ||
          typeof r.path !== "string" ||
          typeof r.destination !== "string" ||
          trashMoves.length >= candidates.size
        )
          throw new GuardrailError("Invalid trash receipt");
        trashMoves.push({ path: r.path, destination: r.destination });
      } else if (r.type === "complete") {
        if (!armed || r.selectedCount !== candidates.size || outcomes.size !== candidates.size)
          throw new GuardrailError("Incomplete journal outcomes");
        complete = true;
      } else throw new GuardrailError("Unknown apply journal record");
    };
    const buffer = Buffer.alloc(8192);
    let pending = "";
    // Decode only whole lines so multibyte paths split across reads survive.
    let carry = Buffer.alloc(0);
    while (true) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      count += n;
      if (count > MAX_BYTES) throw new GuardrailError("Apply journal grew beyond its limit");
      const data = Buffer.concat([carry, buffer.subarray(0, n)]);
      let start = 0;
      for (let i = 0; i < data.length; i++)
        if (data[i] === 10) {
          if (i - start > MAX_LINE) throw new GuardrailError("Oversized journal record");
          pending = data.subarray(start, i).toString("utf8");
          if (pending) consume(pending);
          start = i + 1;
        }
      carry = Buffer.from(data.subarray(start));
      if (carry.length > MAX_LINE) throw new GuardrailError("Oversized journal record");
    }
    // A torn trailing record cannot certify completion.
    if (carry.length) complete = false;
    if (!targetDir) throw new GuardrailError("Missing journal intent");
    for (const candidate of candidates.values())
      candidate.status = complete
        ? outcomes.get(candidate.candidateId)!
        : armed
          ? "unknown"
          : "unattempted";
    const lock = readApplyLockStatus();
    const activeSession =
      lock.owner && resolve(lock.owner.journalPath) === resolve(path)
        ? { pid: lock.owner.pid, processStatus: lock.processStatus ?? ("unknown" as const) }
        : undefined;
    return {
      ...(activeSession ? { activeSession } : {}),
      journalPath: path,
      targetDir,
      complete,
      armed,
      candidates: [...candidates.values()],
      trashMoves: complete ? trashMoves : [],
    };
  } finally {
    closeSync(fd);
  }
}
