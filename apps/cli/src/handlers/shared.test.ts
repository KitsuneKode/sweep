import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
import { basename, delimiter, dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "@kitsunekode/sweep-core/config";
import { scanToPlan } from "@kitsunekode/sweep-core/engine";
import { gitEnv } from "@kitsunekode/sweep-core/git-tracked";
import { GuardrailError } from "@kitsunekode/sweep-core/guardrails";
import { lookupExecutable } from "@kitsunekode/sweep-core/rust-engine";
import type { ApplyProgress, ScanCandidate, ScanPlan } from "@kitsunekode/sweep-protocol";
import {
  assertDangerousConsent,
  assertOpenTuiAvailable,
  executePlanDeletion,
  isOpenTuiAvailable,
  openTuiMissingMessage,
  resetEngineFallbackNoteForTest,
  resolveEngineBackend,
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
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

test("a missing terminal UI library names reinstall, bunx, and standalone fixes", async () => {
  const missing = [
    () => {
      throw new Error("not installed");
    },
  ];
  expect(isOpenTuiAvailable(missing)).toBe(false);
  await expect(assertOpenTuiAvailable(missing)).rejects.toThrow(GuardrailError);
  const message = openTuiMissingMessage();
  expect(message).toMatch(/bun add -g @kitsunekode\/sweep|npm install -g @kitsunekode\/sweep/);
  expect(message).toContain("bunx @kitsunekode/sweep ui <folder>");
  expect(message).toContain("standalone");
  expect(message).not.toContain("npm install @opentui/core");

  const root = mkdtempSync(join(tmpdir(), "sweep-opentui-shared-"));
  roots.push(root);
  const pkgDir = join(root, "node_modules", "@opentui", "core");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@opentui/core", version: "0.6.8" }),
  );
  const entry = join(pkgDir, "index.js");
  writeFileSync(entry, "export const createCliRenderer = () => {};\n");
  expect(
    isOpenTuiAvailable({
      resolvers: [() => entry],
      requiredRange: "^0.6.8",
      requiredExports: ["createCliRenderer"],
    }),
  ).toBe(true);
});

test.skipIf(process.platform === "win32")(
  "--engine auto prints a single stderr note when Rust probe fails for a non-missing reason",
  () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-auto-fallback-"));
    roots.push(root);
    const previousEngine = process.env.SWEEP_ENGINE_PATH;
    const fakeEngine = join(root, "broken-engine");
    writeFileSync(
      fakeEngine,
      "#!/bin/sh\necho \"libc.so.6: version 'GLIBC_2.39' not found\" >&2\nexit 127\n",
    );
    chmodSync(fakeEngine, 0o700);
    process.env.SWEEP_ENGINE_PATH = fakeEngine;
    resetEngineFallbackNoteForTest();

    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    try {
      expect(resolveEngineBackend({ engine: "auto" })).toBe("js");
      expect(resolveEngineBackend({ engine: "auto" })).toBe("js");
    } finally {
      spy.mockRestore();
      if (previousEngine === undefined) delete process.env.SWEEP_ENGINE_PATH;
      else process.env.SWEEP_ENGINE_PATH = previousEngine;
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Rust engine unavailable");
    expect(errors[0]).toContain("GLIBC_2.39");
    expect(errors[0]).toContain("falling back to JS engine");
  },
);

test("--engine auto warns when explicitly configured SWEEP_ENGINE_PATH is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-auto-missing-"));
  roots.push(root);
  const previousEngine = process.env.SWEEP_ENGINE_PATH;
  process.env.SWEEP_ENGINE_PATH = join(root, "does-not-exist");
  resetEngineFallbackNoteForTest();

  const errors: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
  try {
    expect(resolveEngineBackend({ engine: "auto" })).toBe("js");
    // Repeated resolution for the same missing path prints only once.
    expect(resolveEngineBackend({ engine: "auto" })).toBe("js");
  } finally {
    spy.mockRestore();
    if (previousEngine === undefined) delete process.env.SWEEP_ENGINE_PATH;
    else process.env.SWEEP_ENGINE_PATH = previousEngine;
  }

  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("Rust engine unavailable");
  expect(errors[0]).toContain("does-not-exist");
  expect(errors[0]).toContain("falling back to JS engine");
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

function buildPathWithoutGit(tempBin: string): string {
  const nodePath = lookupExecutable("node").resolvedPath;
  const nodeDir = nodePath ? dirname(nodePath) : undefined;
  if (nodePath && nodeDir) {
    if (!lookupExecutable("git", { pathEnv: nodeDir }).resolvedPath) {
      return `${tempBin}${delimiter}${nodeDir}`;
    }
    const target = join(tempBin, basename(nodePath));
    if (process.platform === "win32") copyFileSync(nodePath, target);
    else symlinkSync(nodePath, target);
  }
  return tempBin;
}

const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

test.skipIf(!hasGit)(
  "pre-apply recheck refuses dangerous unknown-tracked candidates and CLI --select all --include-dangerous with no git and no engine",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-unknown-tracked-apply-"));
    roots.push(root);
    const repo = join(root, "repo");
    const configDir = join(root, "config");
    const tempBin = join(root, "bin");
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    mkdirSync(tempBin, { recursive: true });
    writeFileSync(join(repo, "package.json"), "{}\n");
    const committedFile = join(repo, "node_modules", "pkg", "index.js");
    writeFileSync(committedFile, "module.exports = 'committed';\n");

    const runGit = (...args: string[]) => {
      const res = spawnSync("git", ["-C", repo, ...args], { stdio: "ignore", env: gitEnv() });
      expect(res.status).toBe(0);
    };
    runGit("init", "-q");
    runGit("config", "user.email", "t@example.com");
    runGit("config", "user.name", "t");
    runGit("config", "commit.gpgsign", "false");
    runGit("add", "package.json", "node_modules/pkg/index.js");
    runGit("commit", "-qm", "init");

    const pathWithoutGit = buildPathWithoutGit(tempBin);
    const missingEngine = join(root, "missing-sweep-engine");
    const previousPath = process.env.PATH;
    const previousEngine = process.env.SWEEP_ENGINE_PATH;
    process.env.SWEEP_CONFIG_DIR = configDir;
    try {
      process.env.PATH = pathWithoutGit;
      process.env.SWEEP_ENGINE_PATH = missingEngine;
      expect(lookupExecutable("git").resolvedPath).toBeUndefined();

      const { plan } = await scanToPlan(repo, DEFAULT_CONFIG, {
        selectionPolicy: { mode: "all", includeDangerous: true },
      });
      const nm = plan.candidates.find((candidate) => candidate.name === "node_modules");
      expect(nm?.riskTier).toBe("dangerous");
      expect(nm?.reasons).toContain("tracked-status-unknown");
      expect(plan.selectedCandidateIds).toContain(nm!.id);

      await expect(
        executePlanDeletion(plan, "js", { quiet: true, trash: true }),
      ).rejects.toMatchObject({
        applyOutcome: "not_started",
        refusalCode: "tracked_status_unknown",
      });
      expect(existsSync(committedFile)).toBe(true);
      expect(existsSync(join(configDir, "journals"))).toBe(false);
      expect(readdirSync(repo).some((name) => name.startsWith(".sweep-trash-"))).toBe(false);

      const cliBin = join(import.meta.dir, "..", "bin.ts");
      const cliResult = spawnSync(
        process.execPath,
        [
          cliBin,
          "clean",
          repo,
          "--select",
          "all",
          "--include-dangerous",
          "--yes",
          "--allow-dangerous",
          "--json",
        ],
        {
          encoding: "utf8",
        },
      );
      expect(cliResult.status).toBe(2);
      expect(existsSync(committedFile)).toBe(true);
      const stderrLines = cliResult.stderr.trim().split(/\r?\n/);
      const errorDoc = JSON.parse(stderrLines[stderrLines.length - 1]!) as {
        code: string;
        applyOutcome: string;
        message: string;
      };
      expect(errorDoc.code).toBe("tracked_status_unknown");
      expect(errorDoc.applyOutcome).toBe("not_started");
      expect(errorDoc.message).toContain("could not be checked for git-tracked files");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousEngine === undefined) delete process.env.SWEEP_ENGINE_PATH;
      else process.env.SWEEP_ENGINE_PATH = previousEngine;
    }
  },
);

test.skipIf(!hasGit)(
  "contains-git-repository refuses bulk apply but permits explicitSingleSelection, while git-tracked always refuses",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-nested-repo-apply-"));
    roots.push(root);
    const configDir = join(root, "config");
    const repo = join(root, "repo");
    const nestedPkg = join(repo, "node_modules", "pkg");
    mkdirSync(nestedPkg, { recursive: true });
    writeFileSync(join(repo, "package.json"), "{}\n");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    writeFileSync(join(nestedPkg, "index.js"), "module.exports = 1;\n");

    const runGitIn = (dir: string, ...args: string[]) => {
      const res = spawnSync("git", ["-C", dir, ...args], { stdio: "ignore", env: gitEnv() });
      expect(res.status).toBe(0);
    };
    runGitIn(repo, "init", "-q");
    runGitIn(repo, "config", "user.email", "t@example.com");
    runGitIn(repo, "config", "user.name", "t");
    runGitIn(repo, "config", "commit.gpgsign", "false");
    runGitIn(repo, "add", "package.json", ".gitignore");
    runGitIn(repo, "commit", "-qm", "init");

    runGitIn(nestedPkg, "init", "-q");
    runGitIn(nestedPkg, "config", "user.email", "t@example.com");
    runGitIn(nestedPkg, "config", "user.name", "t");
    runGitIn(nestedPkg, "config", "commit.gpgsign", "false");
    runGitIn(nestedPkg, "add", "index.js");
    runGitIn(nestedPkg, "commit", "-qm", "nested init");

    const prevConfig = process.env.SWEEP_CONFIG_DIR;
    process.env.SWEEP_CONFIG_DIR = configDir;
    try {
      const { plan } = await scanToPlan(repo, DEFAULT_CONFIG, {
        selectionPolicy: { mode: "all", includeDangerous: true },
      });
      const nm = plan.candidates.find((c) => c.name === "node_modules");
      expect(nm?.riskTier).toBe("dangerous");
      expect(nm?.reasons).toContain("contains-git-repository");
      expect(nm?.selectedByDefault).toBe(false);

      // Default/bulk apply refuses with contains_git_repository.
      await expect(executePlanDeletion(plan, "js", { quiet: true })).rejects.toMatchObject({
        applyOutcome: "not_started",
        refusalCode: "contains_git_repository",
      });
      expect(existsSync(join(nestedPkg, "index.js"))).toBe(true);

      // Explicit single-item confirmation (TUI `x`) permits removing that one candidate.
      const singleRes = await executePlanDeletion(plan, "js", {
        quiet: true,
        explicitSingleSelection: true,
      });
      expect(singleRes.report.deletedCount).toBe(1);
      expect(existsSync(join(nestedPkg, "index.js"))).toBe(false);

      // Contrast: a node_modules that is itself a git repo with commits is git-tracked and refused even with explicitSingleSelection.
      const selfRepoParent = join(root, "self-repo-parent");
      const selfNm = join(selfRepoParent, "node_modules");
      mkdirSync(join(selfNm, "pkg"), { recursive: true });
      writeFileSync(join(selfRepoParent, "package.json"), "{}\n");
      writeFileSync(join(selfNm, "pkg", "index.js"), "module.exports = 2;\n");
      runGitIn(selfNm, "init", "-q");
      runGitIn(selfNm, "config", "user.email", "t@example.com");
      runGitIn(selfNm, "config", "user.name", "t");
      runGitIn(selfNm, "config", "commit.gpgsign", "false");
      runGitIn(selfNm, "add", "pkg/index.js");
      runGitIn(selfNm, "commit", "-qm", "self init");

      const { plan: selfPlan } = await scanToPlan(selfRepoParent, DEFAULT_CONFIG);
      const selfCand = selfPlan.candidates.find((c) => c.name === "node_modules");
      expect(selfCand?.riskTier).toBe("blocked");
      expect(selfCand?.reasons).toContain("git-tracked");
      expect(selfCand?.reasons).toContain("contains-git-repository");
      const forcedSingle = {
        ...selfPlan,
        selectedCandidateIds: [selfCand!.id],
        summary: { ...selfPlan.summary, selectedCount: 1 },
      };
      await expect(
        executePlanDeletion(forcedSingle, "js", { quiet: true, explicitSingleSelection: true }),
      ).rejects.toMatchObject({
        applyOutcome: "not_started",
        refusalCode: "git_tracked",
      });
      expect(existsSync(join(selfNm, "pkg", "index.js"))).toBe(true);
    } finally {
      if (prevConfig === undefined) delete process.env.SWEEP_CONFIG_DIR;
      else process.env.SWEEP_CONFIG_DIR = prevConfig;
    }
  },
);
