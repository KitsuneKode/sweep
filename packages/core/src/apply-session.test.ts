import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginApplySession, recoverApplyJournal, readApplyLockStatus } from "./apply-session.js";
import { scanToPlan } from "./engine.js";
import { DEFAULT_CONFIG } from "./config.js";

const roots: string[] = [];
const oldConfig = process.env.SWEEP_CONFIG_DIR;
afterEach(() => {
  if (oldConfig === undefined) delete process.env.SWEEP_CONFIG_DIR;
  else process.env.SWEEP_CONFIG_DIR = oldConfig;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sweep-session-"));
  roots.push(root);
  process.env.SWEEP_CONFIG_DIR = join(root, "config");
  mkdirSync(join(root, "project", "node_modules"), { recursive: true });
  writeFileSync(join(root, "project", "node_modules", "keep"), "data");
  return (await scanToPlan(join(root, "project"), DEFAULT_CONFIG)).plan;
}

test("an unfinished durable intent recovers as unknown and never retries deletion", async () => {
  const plan = await fixture();
  const session = beginApplySession(plan, "js");
  try {
    const recovered = recoverApplyJournal(session.journalPath);
    expect(recovered.complete).toBe(false);
    expect(recovered.candidates.map((c) => c.status)).toEqual(["unknown"]);
    expect(readFileSync(join(plan.candidates[0]!.path, "keep"), "utf8")).toBe("data");
    expect(() => beginApplySession(plan, "rust")).toThrow("apply lock");
  } finally {
    session.close();
  }
});

test("committed outcomes recover and a closed session releases only its own lock", async () => {
  const plan = await fixture();
  const session = beginApplySession(plan, "js");
  session.finish({
    protocolVersion: "1",
    targetDir: plan.targetDir,
    selectedCandidateIds: plan.selectedCandidateIds,
    deletedCount: 0,
    failedCount: 0,
    totalBytesFreed: 0,
    failedPaths: [],
    interrupted: true,
    outcomes: plan.selectedCandidateIds.map((candidateId) => ({
      candidateId,
      status: "unattempted",
    })),
  });
  session.close();
  session.close();
  const recovered = recoverApplyJournal(session.journalPath);
  expect(recovered.complete).toBe(true);
  expect(recovered.candidates[0]!.status).toBe("unattempted");
  const next = beginApplySession(plan, "rust");
  next.close();
});

test("journal storage refuses symlink roots without changing their destination", async () => {
  if (process.platform === "win32") return;
  const plan = await fixture();
  const config = process.env.SWEEP_CONFIG_DIR!;
  const outside = join(roots[0]!, "outside");
  mkdirSync(outside);
  symlinkSync(outside, config);
  expect(() => beginApplySession(plan, "js")).toThrow();
  expect(() => readFileSync(join(outside, "apply.lock", "owner.json"))).toThrow();
});

test("a torn completion cannot turn uncertain intents into deleted receipts", async () => {
  const plan = await fixture();
  const session = beginApplySession(plan, "js");
  session.close();
  const id = plan.selectedCandidateIds[0]!;
  const raw = readFileSync(session.journalPath, "utf8");
  writeFileSync(
    session.journalPath,
    raw +
      JSON.stringify({ type: "outcome", candidateId: id, status: "deleted" }) +
      '\n{"type":"complete"',
  );
  const recovered = recoverApplyJournal(session.journalPath);
  expect(recovered.complete).toBe(false);
  expect(recovered.candidates[0]!.status).toBe("unknown");
  expect(recovered.candidates[0]!.recordedStatus).toBe("deleted");
  expect(existsSync(plan.candidates[0]!.path)).toBe(true);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "failed journal creation releases its empty owned lock before any deletion",
  async () => {
    const plan = await fixture();
    const config = process.env.SWEEP_CONFIG_DIR!;
    const journals = join(config, "journals");
    mkdirSync(journals, { recursive: true, mode: 0o700 });
    chmodSync(journals, 0o500);
    try {
      expect(() => beginApplySession(plan, "js")).toThrow();
      expect(existsSync(join(config, "apply.lock"))).toBe(false);
      expect(readFileSync(join(plan.candidates[0]!.path, "keep"), "utf8")).toBe("data");
    } finally {
      chmodSync(journals, 0o700);
    }
  },
);

test("lock diagnostics report the live owner without releasing or replaying it", async () => {
  const plan = await fixture();
  expect(readApplyLockStatus().held).toBe(false);
  const session = beginApplySession(plan, "js");
  try {
    expect(readApplyLockStatus()).toMatchObject({
      held: true,
      processStatus: "running",
      owner: {
        pid: process.pid,
        targetDir: plan.targetDir,
        journalPath: session.journalPath,
      },
    });
    expect(recoverApplyJournal(session.journalPath).activeSession).toMatchObject({
      pid: process.pid,
      processStatus: "running",
    });
    expect(existsSync(join(process.env.SWEEP_CONFIG_DIR!, "apply.lock"))).toBe(true);
  } finally {
    session.close();
  }
  expect(readApplyLockStatus().held).toBe(false);
});
