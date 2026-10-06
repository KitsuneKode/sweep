import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@kitsunekode/sweep-core/config";
import { scanToPlan } from "@kitsunekode/sweep-core/engine";
import type { ApplyProgress } from "@kitsunekode/sweep-protocol";
import { executePlanDeletion } from "./shared.js";

const roots: string[] = [];
const previousConfig = process.env.SWEEP_CONFIG_DIR;
afterEach(() => {
  if (previousConfig === undefined) delete process.env.SWEEP_CONFIG_DIR;
  else process.env.SWEEP_CONFIG_DIR = previousConfig;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sweep-apply-ui-feedback-"));
  roots.push(root);
  process.env.SWEEP_CONFIG_DIR = join(root, "config");
  const target = join(root, "project");
  for (const name of ["one/node_modules", "two/node_modules"]) {
    mkdirSync(join(target, name), { recursive: true });
    writeFileSync(join(target, name, "data"), "keep until confirmed");
  }
  const { plan } = await scanToPlan(target, DEFAULT_CONFIG);
  plan.selectedCandidateIds = plan.candidates.map((candidate) => candidate.id);
  return plan;
}

test("quiet UI apply delivers progress and cancellation preserves unattempted entries", async () => {
  const plan = await fixture();
  const controller = new AbortController();
  const progress: ApplyProgress[] = [];
  const result = await executePlanDeletion(plan, "js", {
    quiet: true,
    signal: controller.signal,
    onProgress: (update) => {
      progress.push(update);
      if (update.stage === "applying") controller.abort();
    },
  });
  expect(progress[0]?.stage).toBe("preparing");
  expect(progress.some((update) => update.stage === "applying")).toBe(true);
  expect(result.interrupted).toBe(true);
  expect(result.report.deletedCount).toBe(0);
  expect(result.report.outcomes?.every((outcome) => outcome.status === "unattempted")).toBe(true);
  expect(plan.candidates.every((candidate) => existsSync(candidate.path))).toBe(true);
  expect(existsSync(join(process.env.SWEEP_CONFIG_DIR!, "apply.lock"))).toBe(false);
});

test("a failed feedback sink cannot change deletion outcomes or strand the apply lock", async () => {
  const plan = await fixture();
  const result = await executePlanDeletion(plan, "js", {
    quiet: true,
    onProgress: () => {
      throw new Error("display disappeared");
    },
  });
  expect(result.report.deletedCount).toBe(2);
  expect(result.report.failedCount).toBe(0);
  expect(plan.candidates.every((candidate) => !existsSync(candidate.path))).toBe(true);
  expect(existsSync(join(process.env.SWEEP_CONFIG_DIR!, "apply.lock"))).toBe(false);
});

test("size refusal leaves the source, selection and journal directory untouched", async () => {
  const plan = await fixture();
  await expect(
    executePlanDeletion(plan, "js", { quiet: true, maxSizeGB: 0 }),
  ).rejects.toMatchObject({
    applyOutcome: "not_started",
    refusalCode: "size_limit_exceeded",
  });
  expect(plan.selectedCandidateIds).toHaveLength(2);
  expect(plan.candidates.every((candidate) => existsSync(candidate.path))).toBe(true);
  expect(existsSync(join(process.env.SWEEP_CONFIG_DIR!, "journals"))).toBe(false);
});

test("fresh-size refusal completes the armed journal with every entry unattempted", async () => {
  const plan = await fixture();
  for (const candidate of plan.candidates) candidate.estimatedBytes = 0;
  plan.summary.estimatedTotalBytes = 0;
  await expect(
    executePlanDeletion(plan, "js", { quiet: true, maxSizeGB: 0 }),
  ).rejects.toMatchObject({
    applyOutcome: "not_started",
    refusalCode: "size_limit_exceeded",
  });
  const journals = join(process.env.SWEEP_CONFIG_DIR!, "journals");
  const { recoverApplyJournal } = await import("@kitsunekode/sweep-core/apply-session");
  const recovered = recoverApplyJournal(join(journals, readdirSync(journals)[0]!));
  expect(recovered.complete).toBe(true);
  expect(recovered.candidates.every((candidate) => candidate.status === "unattempted")).toBe(true);
  expect(plan.candidates.every((candidate) => existsSync(candidate.path))).toBe(true);
});

test("cancelling fresh sizing returns an authoritative unattempted partition", async () => {
  const plan = await fixture();
  const controller = new AbortController();
  const progress: ApplyProgress[] = [];
  const result = await executePlanDeletion(plan, "js", {
    quiet: true,
    maxSizeGB: 10,
    signal: controller.signal,
    onProgress: (update) => {
      progress.push(update);
      if (update.stage === "preparing" && update.activePath) controller.abort();
    },
  });
  expect(progress.some((update) => update.stage === "preparing" && update.activePath)).toBe(true);
  expect(result.interrupted).toBe(true);
  expect(result.report.deletedCount).toBe(0);
  expect(result.report.outcomes?.every((outcome) => outcome.status === "unattempted")).toBe(true);
});

test("lock contention refuses without changing either session or signal listeners", async () => {
  const plan = await fixture();
  const { beginApplySession } = await import("@kitsunekode/sweep-core/apply-session");
  const owner = beginApplySession(plan, "js");
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
  const listeners = signals.map((signal) => process.listenerCount(signal));
  try {
    await expect(
      executePlanDeletion(plan, "js", { quiet: true, maxSizeGB: 10 }),
    ).rejects.toMatchObject({
      applyOutcome: "not_started",
      refusalCode: "apply_busy",
    });
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(listeners);
    expect(existsSync(join(process.env.SWEEP_CONFIG_DIR!, "apply.lock"))).toBe(true);
    expect(plan.candidates.every((candidate) => existsSync(candidate.path))).toBe(true);
  } finally {
    owner.close();
  }
});

test("an aborted JS scan cannot become a complete programmatic plan", async () => {
  const plan = await fixture();
  const controller = new AbortController();
  await expect(
    scanToPlan(plan.targetDir, DEFAULT_CONFIG, {
      signal: controller.signal,
      onEntry: () => controller.abort(),
    }),
  ).rejects.toMatchObject({ code: 1 });
  expect(plan.candidates.every((candidate) => existsSync(candidate.path))).toBe(true);
});
