import { afterEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@kitsunekode/sweep-core/config";
import { scanToPlan } from "@kitsunekode/sweep-core/engine";
import { GuardrailError } from "@kitsunekode/sweep-core/guardrails";
import type { ApplyProgress, ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import {
  assertDangerousConsent,
  assertOpenTuiAvailable,
  executePlanDeletion,
  isOpenTuiAvailable,
  openTuiMissingMessage,
  resolveScanTarget,
} from "./shared.js";

const roots: string[] = [];
const previousConfig = process.env.SWEEP_CONFIG_DIR;

test.skipIf(process.platform === "win32")(
  "CLI aliases and trailing separators resolve to one applicable target",
  () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-target-spelling-"));
    roots.push(root);
    const target = join(root, "project");
    mkdirSync(target);
    const alias = join(root, "link");
    symlinkSync(target, alias);
    expect(resolveScanTarget(target + "/")).toBe(realpathSync(target));
    expect(resolveScanTarget(alias)).toBe(realpathSync(target));
  },
);
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

test("an unavailable engine leaves a complete unattempted journal and releases its lock", async () => {
  const plan = await fixture();
  const previousEngine = process.env.SWEEP_ENGINE_PATH;
  process.env.SWEEP_ENGINE_PATH = join(plan.targetDir, "missing-engine");
  try {
    await expect(executePlanDeletion(plan, "rust", { quiet: true })).rejects.toMatchObject({
      applyOutcome: "not_started",
      refusalCode: "engine_unavailable",
    });
    const journals = join(process.env.SWEEP_CONFIG_DIR!, "journals");
    const { recoverApplyJournal } = await import("@kitsunekode/sweep-core/apply-session");
    const recovered = recoverApplyJournal(join(journals, readdirSync(journals)[0]!));
    expect(recovered.complete).toBe(true);
    expect(recovered.candidates).toHaveLength(plan.selectedCandidateIds.length);
    expect(recovered.candidates.every((candidate) => candidate.status === "unattempted")).toBe(
      true,
    );
    expect(plan.candidates.every((candidate) => existsSync(candidate.path))).toBe(true);
    expect(existsSync(join(process.env.SWEEP_CONFIG_DIR!, "apply.lock"))).toBe(false);
  } finally {
    if (previousEngine === undefined) delete process.env.SWEEP_ENGINE_PATH;
    else process.env.SWEEP_ENGINE_PATH = previousEngine;
  }
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

function claimedPlan(path: string, name: string, riskTier: ScanCandidate["riskTier"]): ScanPlan {
  return {
    protocolVersion: "1",
    targetDir: "/sweep-consent",
    selectionPolicy: { mode: "all", includeDangerous: true },
    candidates: [
      {
        id: "c1",
        path,
        name,
        kind: "custom",
        estimatedBytes: 1,
        isSymlink: false,
        entryType: "directory",
        riskTier,
        reasons: ["custom-pattern"],
        selectedByDefault: false,
      },
    ],
    summary: {
      candidateCount: 1,
      estimatedTotalBytes: 1,
      scannedDirs: 1,
      exact: true,
      selectedCount: 1,
      riskCounts: { safe: 0, caution: 0, dangerous: riskTier === "dangerous" ? 1 : 0, blocked: 0 },
    },
    selectedCandidateIds: ["c1"],
    createdAt: "1970-01-01T00:00:00.000Z",
  };
}

test("a missing terminal UI library names a reinstall of sweep, not a second npm install", () => {
  const missing = [
    () => {
      throw new Error("not installed");
    },
  ];
  expect(isOpenTuiAvailable(missing)).toBe(false);
  expect(() => assertOpenTuiAvailable(missing)).toThrow(GuardrailError);
  const message = openTuiMissingMessage();
  expect(message).toMatch(/bun add -g @kitsunekode\/sweep|npm install -g @kitsunekode\/sweep/);
  expect(message).toContain("bun add -g @opentui/core");
  expect(message).toContain("sweep ui <folder>");
  expect(message).not.toContain("npm install @opentui/core");
  expect(isOpenTuiAvailable([() => "/opt/opentui/core"])).toBe(true);
});

test("unattended consent follows the live tier, and --json still names the path", () => {
  const forged = claimedPlan("/sweep-consent/proj/custom-cache", "node_modules", "safe");
  expect(() => assertDangerousConsent(forged, { yes: true })).toThrow(GuardrailError);
  expect(() => assertDangerousConsent(forged, { yes: true, allowDangerous: true })).not.toThrow();

  const errors: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
  try {
    assertDangerousConsent(forged, { yes: true, allowDangerous: true, json: true });
  } finally {
    spy.mockRestore();
  }
  expect(errors.join("\n")).toContain("/sweep-consent/proj/custom-cache");

  const honest = claimedPlan("/sweep-consent/proj/node_modules", "node_modules", "safe");
  expect(() => assertDangerousConsent(honest, { yes: true, json: true })).not.toThrow();

  const labeled = claimedPlan("/sweep-consent/proj/node_modules", "node_modules", "dangerous");
  expect(() => assertDangerousConsent(labeled, { yes: true })).toThrow(GuardrailError);
});

test("resource refusal never arms a journal or creates trash", async () => {
  const plan = await fixture();
  plan.summary.estimatedTotalBytes = Number.MAX_SAFE_INTEGER + 1;
  await expect(executePlanDeletion(plan, "js", { quiet: true, trash: true })).rejects.toMatchObject(
    {
      applyOutcome: "not_started",
      refusalCode: "resource_limit_exceeded",
    },
  );
  expect(plan.candidates.every((candidate) => existsSync(candidate.path))).toBe(true);
  expect(existsSync(join(process.env.SWEEP_CONFIG_DIR!, "journals"))).toBe(false);
  expect(readdirSync(plan.targetDir).some((name) => name.startsWith(".sweep-trash-"))).toBe(false);
});
