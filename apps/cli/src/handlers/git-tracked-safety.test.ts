import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import {
  isRustEngineAvailable,
  lookupExecutable,
  probeRustEngine,
} from "@kitsunekode/sweep-core/rust-engine";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";

const CLI_BIN = join(import.meta.dir, "..", "bin.ts");
const HAS_GIT = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const RUST_PROBE = probeRustEngine();
const RUST_AVAILABLE = isRustEngineAvailable() && Boolean(RUST_PROBE.resolvedPath);
const ENGINES = RUST_AVAILABLE ? (["js", "rust"] as const) : (["js"] as const);
const SAFETY_TEST_TIMEOUT_MS = 60_000;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function runGit(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  expect(res.status).toBe(0);
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  runGit(dir, "init", "-q");
  runGit(dir, "config", "user.email", "t@example.com");
  runGit(dir, "config", "user.name", "t");
  runGit(dir, "config", "commit.gpgsign", "false");
}

function makeEmptyIndexRepo(dir: string): { gitDir: string; emptyIndex: string } {
  initRepo(dir);
  writeFileSync(join(dir, "tmp.txt"), "x\n");
  runGit(dir, "add", "tmp.txt");
  runGit(dir, "rm", "--cached", "-q", "tmp.txt");
  const emptyIndex = join(dir, ".git", "index");
  expect(statSync(emptyIndex).size).toBe(32);
  return { gitDir: join(dir, ".git"), emptyIndex };
}

function commitNodeModules(repo: string, relDir = "node_modules"): string {
  const file = join(repo, relDir, "pkg", "index.js");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(join(repo, "package.json"), "{}\n");
  writeFileSync(file, "module.exports = 'committed';\n");
  runGit(repo, "add", "package.json", `${relDir}/pkg/index.js`);
  runGit(repo, "commit", "-qm", "init");
  return file;
}

function buildPathWithoutGit(tempBin: string): string {
  mkdirSync(tempBin, { recursive: true });
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

function buildPathWithFailingGit(tempBin: string): string {
  const basePath = buildPathWithoutGit(tempBin);
  if (process.platform === "win32") {
    copyFileSync(process.execPath, join(tempBin, "git.exe"));
  } else {
    const fakeGit = join(tempBin, "git");
    writeFileSync(fakeGit, "#!/bin/sh\nexit 1\n");
    chmodSync(fakeGit, 0o755);
  }
  return basePath;
}

function buildEngineEnv(
  root: string,
  engine: "js" | "rust",
  extraEnv: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const configDir = mkdtempSync(join(root, "cfg-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SWEEP_CONFIG_DIR: configDir,
    XDG_CONFIG_HOME: configDir,
    SWEEP_ENGINE_PATH:
      engine === "rust" ? RUST_PROBE.resolvedPath : join(root, "missing-sweep-engine"),
    ...extraEnv,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function hasTrashDir(dir: string): boolean {
  return readdirSync(dir).some((name) => name.startsWith(".sweep-trash-"));
}

function assertProtectedAcrossAllRoutes(options: {
  root: string;
  target: string;
  committedFile: string;
  engine: "js" | "rust";
  expectedTier: "blocked" | "dangerous";
  expectedReason: "git-tracked" | "tracked-status-unknown";
  extraEnv?: Record<string, string | undefined>;
}): void {
  const { root, target, committedFile, engine, expectedTier, expectedReason, extraEnv } = options;

  // 1. Default plan: candidate is classified properly and not selected.
  const planRes = runCli(
    ["plan", target, "--engine", engine, "--json"],
    buildEngineEnv(root, engine, extraEnv),
  );
  expect(planRes.status).toBe(0);
  const defaultPlan = JSON.parse(planRes.stdout) as ScanPlan;
  const nm = defaultPlan.candidates.find((candidate) => candidate.name === "node_modules");
  expect(nm).toBeDefined();
  expect(nm?.riskTier).toBe(expectedTier);
  expect(nm?.reasons).toContain(expectedReason);
  expect(nm?.selectedByDefault).toBe(false);
  expect(defaultPlan.selectedCandidateIds).not.toContain(nm!.id);

  // Default clean does not delete the committed file.
  const defaultClean = runCli(
    ["clean", target, "--engine", engine, "--yes", "--json"],
    buildEngineEnv(root, engine, extraEnv),
  );
  expect(defaultClean.status).toBe(0);
  expect(existsSync(committedFile)).toBe(true);

  // 2. --select all --include-dangerous --allow-dangerous --yes does not delete it.
  const dangerousClean = runCli(
    [
      "clean",
      target,
      "--engine",
      engine,
      "--select",
      "all",
      "--include-dangerous",
      "--allow-dangerous",
      "--yes",
      "--json",
    ],
    buildEngineEnv(root, engine, extraEnv),
  );
  if (expectedTier === "dangerous") {
    expect(dangerousClean.status).toBe(2);
    expect(dangerousClean.stderr).toContain("tracked_status_unknown");
  } else {
    expect(dangerousClean.status).toBe(0);
  }
  expect(existsSync(committedFile)).toBe(true);

  // 3. A saved plan applied later does not delete it (even when saved with --select all --include-dangerous
  // and even if the saved plan explicitly selects the candidate id).
  const savedPlanPath = join(root, `saved-${engine}-${Math.random().toString(36).slice(2)}.json`);
  const saveRes = runCli(
    ["plan", target, "--engine", engine, "--select", "all", "--include-dangerous", "--json"],
    buildEngineEnv(root, engine, extraEnv),
  );
  expect(saveRes.status).toBe(0);
  writeFileSync(savedPlanPath, saveRes.stdout);
  const applySaved = runCli(
    ["apply", "--plan", savedPlanPath, "--engine", engine, "--yes", "--allow-dangerous", "--json"],
    buildEngineEnv(root, engine, extraEnv),
  );
  if (expectedTier === "dangerous") {
    expect(applySaved.status).toBe(2);
    expect(applySaved.stderr).toContain("tracked_status_unknown");
  } else {
    expect(applySaved.status).toBe(0);
  }
  expect(existsSync(committedFile)).toBe(true);

  // Also test applying a forged saved plan that claims node_modules is safe and selected.
  const forgedPlan = JSON.parse(readFileSync(savedPlanPath, "utf8")) as ScanPlan;
  const forgedPlanPath = join(root, `forged-${engine}-${Math.random().toString(36).slice(2)}.json`);
  forgedPlan.candidates = forgedPlan.candidates.map((candidate) =>
    candidate.id === nm!.id
      ? { ...candidate, riskTier: "safe", selectedByDefault: true }
      : candidate,
  );
  forgedPlan.selectedCandidateIds = [nm!.id];
  forgedPlan.summary.selectedCount = 1;
  writeFileSync(forgedPlanPath, JSON.stringify(forgedPlan, null, 2));
  const applyForged = runCli(
    ["apply", "--plan", forgedPlanPath, "--engine", engine, "--yes", "--allow-dangerous", "--json"],
    buildEngineEnv(root, engine, extraEnv),
  );
  expect(applyForged.status).toBe(2);
  expect(applyForged.stderr).toContain(
    expectedTier === "dangerous" ? "tracked_status_unknown" : "git_tracked",
  );
  expect(existsSync(committedFile)).toBe(true);

  // 4. --trash does not delete it and creates no .sweep-trash-* directory.
  const trashClean = runCli(
    [
      "clean",
      target,
      "--engine",
      engine,
      "--select",
      "all",
      "--include-dangerous",
      "--allow-dangerous",
      "--yes",
      "--trash",
      "--json",
    ],
    buildEngineEnv(root, engine, extraEnv),
  );
  if (expectedTier === "dangerous") {
    expect(trashClean.status).toBe(2);
    expect(trashClean.stderr).toContain("tracked_status_unknown");
  } else {
    expect(trashClean.status).toBe(0);
  }
  expect(existsSync(committedFile)).toBe(true);
  expect(hasTrashDir(target)).toBe(false);
}

describe.skipIf(!HAS_GIT)("git-tracked CLI safety matrix across engines", () => {
  test(
    "32-byte empty index in a gitfile target with no HEAD is protected across all routes in both engines",
    () => {
      const root = makeRoot("sweep-matrix-empty-idx-");
      const { emptyIndex } = makeEmptyIndexRepo(join(root, "empty-src"));
      const repo = join(root, "repo");
      const fakeGitdir = join(root, "fake-gitdir");
      const preserved = join(root, "preserved");
      mkdirSync(fakeGitdir, { recursive: true });
      copyFileSync(emptyIndex, join(fakeGitdir, "index"));

      initRepo(repo);
      const committedFile = commitNodeModules(repo);
      renameSync(join(repo, ".git"), preserved);
      writeFileSync(join(repo, ".git"), `gitdir: ${fakeGitdir.replaceAll("\\", "/")}\n`);

      for (const engine of ENGINES) {
        assertProtectedAcrossAllRoutes({
          root,
          target: repo,
          committedFile,
          engine,
          expectedTier: "dangerous",
          expectedReason: "tracked-status-unknown",
        });
      }
    },
    SAFETY_TEST_TIMEOUT_MS,
  );

  test(
    "GIT_DIR and GIT_INDEX_FILE pointed at an empty repo/index cannot bypass protection in either engine",
    () => {
      const root = makeRoot("sweep-matrix-git-env-");
      const { gitDir, emptyIndex } = makeEmptyIndexRepo(join(root, "empty-repo"));
      const repo = join(root, "repo");
      initRepo(repo);
      const committedFile = commitNodeModules(repo);

      const spoofEnv = {
        GIT_DIR: gitDir,
        GIT_INDEX_FILE: emptyIndex,
        GIT_WORK_TREE: join(root, "empty-repo"),
      };
      for (const engine of ENGINES) {
        assertProtectedAcrossAllRoutes({
          root,
          target: repo,
          committedFile,
          engine,
          expectedTier: "blocked",
          expectedReason: "git-tracked",
          extraEnv: spoofEnv,
        });
      }

      // Also verify GIT_DIR pointed at an empty repo cannot mask a broken gitfile.
      const brokenRepo = join(root, "broken-repo");
      const brokenGitdir = join(root, "broken-gitdir");
      const preserved = join(root, "preserved");
      mkdirSync(brokenGitdir, { recursive: true });
      initRepo(brokenRepo);
      const brokenFile = commitNodeModules(brokenRepo);
      renameSync(join(brokenRepo, ".git"), preserved);
      writeFileSync(join(brokenRepo, ".git"), `gitdir: ${brokenGitdir.replaceAll("\\", "/")}\n`);
      for (const engine of ENGINES) {
        assertProtectedAcrossAllRoutes({
          root,
          target: brokenRepo,
          committedFile: brokenFile,
          engine,
          expectedTier: "dangerous",
          expectedReason: "tracked-status-unknown",
          extraEnv: spoofEnv,
        });
      }
    },
    SAFETY_TEST_TIMEOUT_MS,
  );

  test(
    "parent repo tracking nested/node_modules plus git init inside nested stays blocked in both engines",
    () => {
      const root = makeRoot("sweep-matrix-nested-");
      const parent = join(root, "parent");
      const nested = join(parent, "nested");
      initRepo(parent);
      const committedFile = commitNodeModules(parent, "nested/node_modules");
      initRepo(nested);

      for (const engine of ENGINES) {
        assertProtectedAcrossAllRoutes({
          root,
          target: nested,
          committedFile,
          engine,
          expectedTier: "blocked",
          expectedReason: "git-tracked",
        });
      }
    },
    SAFETY_TEST_TIMEOUT_MS,
  );

  test.skipIf(process.platform === "win32")(
    "an engine printing the old SWEEP_TRACKED_V2 header is rejected and falls back cleanly in both engines",
    () => {
      const root = makeRoot("sweep-matrix-v2-");
      const { emptyIndex } = makeEmptyIndexRepo(join(root, "empty-src"));
      const fakeEngine = join(root, "sweep-engine-v2");
      const realEngine = RUST_PROBE.resolvedPath;
      writeFileSync(
        fakeEngine,
        [
          "#!/bin/sh",
          'if [ "$1" = "tracked" ]; then printf "SWEEP_TRACKED_V2\\0"; exit 0; fi',
          realEngine
            ? `exec ${JSON.stringify(realEngine)} "$@"`
            : 'if [ "$1" = "--version" ]; then echo "sweep-engine 0.5.2"; exit 0; fi; exit 1',
        ].join("\n"),
      );
      chmodSync(fakeEngine, 0o755);

      // Broken 32-byte empty-index gitfile: a V2 engine falsely prints an empty V2 header,
      // so rejecting V2 must fall back to git and fail closed as unknown.
      const repo = join(root, "repo");
      const fakeGitdir = join(root, "fake-gitdir");
      const preserved = join(root, "preserved");
      mkdirSync(fakeGitdir, { recursive: true });
      copyFileSync(emptyIndex, join(fakeGitdir, "index"));
      initRepo(repo);
      const committedFile = commitNodeModules(repo);
      renameSync(join(repo, ".git"), preserved);
      writeFileSync(join(repo, ".git"), `gitdir: ${fakeGitdir.replaceAll("\\", "/")}\n`);

      for (const engine of ENGINES) {
        assertProtectedAcrossAllRoutes({
          root,
          target: repo,
          committedFile,
          engine,
          expectedTier: "dangerous",
          expectedReason: "tracked-status-unknown",
          extraEnv: { SWEEP_ENGINE_PATH: fakeEngine },
        });
      }
    },
    SAFETY_TEST_TIMEOUT_MS,
  );

  test(
    "git exiting 1 protects a healthy repo as unknown across all routes in both engines",
    () => {
      const root = makeRoot("sweep-matrix-git-exit1-");
      const repo = join(root, "repo");
      initRepo(repo);
      const committedFile = commitNodeModules(repo);
      const pathWithFailingGit = buildPathWithFailingGit(join(root, "fail-bin"));

      for (const engine of ENGINES) {
        assertProtectedAcrossAllRoutes({
          root,
          target: repo,
          committedFile,
          engine,
          expectedTier: "dangerous",
          expectedReason: "tracked-status-unknown",
          extraEnv: { PATH: pathWithFailingGit },
        });
      }
    },
    SAFETY_TEST_TIMEOUT_MS,
  );

  test(
    "no git on PATH protects a committed node_modules across all routes in both engines",
    () => {
      const root = makeRoot("sweep-matrix-no-git-");
      const repo = join(root, "repo");
      initRepo(repo);
      const committedFile = commitNodeModules(repo);
      const pathWithoutGit = buildPathWithoutGit(join(root, "no-git-bin"));

      for (const engine of ENGINES) {
        assertProtectedAcrossAllRoutes({
          root,
          target: repo,
          committedFile,
          engine,
          // Rust engine validates the repository and reads its checksum-verified non-empty index;
          // JS without the native binary fails closed as tracked-status-unknown.
          expectedTier: engine === "rust" ? "blocked" : "dangerous",
          expectedReason: engine === "rust" ? "git-tracked" : "tracked-status-unknown",
          extraEnv: { PATH: pathWithoutGit },
        });
      }
    },
    SAFETY_TEST_TIMEOUT_MS,
  );

  test(
    "controls: healthy committed repo blocked, untracked node_modules removable, and deleted-index matches git",
    () => {
      const root = makeRoot("sweep-matrix-controls-");

      // Control 1: healthy repo with committed node_modules is blocked in both engines.
      const healthyBlocked = join(root, "healthy-blocked");
      initRepo(healthyBlocked);
      const blockedFile = commitNodeModules(healthyBlocked);
      for (const engine of ENGINES) {
        assertProtectedAcrossAllRoutes({
          root,
          target: healthyBlocked,
          committedFile: blockedFile,
          engine,
          expectedTier: "blocked",
          expectedReason: "git-tracked",
        });
      }

      // Control 2: untracked node_modules in a healthy repo is still removable in both engines.
      for (const engine of ENGINES) {
        const repo = join(root, `untracked-${engine}`);
        initRepo(repo);
        writeFileSync(join(repo, "package.json"), "{}\n");
        writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
        runGit(repo, "add", "package.json", ".gitignore");
        runGit(repo, "commit", "-qm", "init");

        const nmFile = join(repo, "node_modules", "pkg", "index.js");
        mkdirSync(dirname(nmFile), { recursive: true });
        writeFileSync(nmFile, "module.exports = 'untracked';\n");

        const planRes = runCli(
          ["plan", repo, "--engine", engine, "--json"],
          buildEngineEnv(root, engine),
        );
        expect(planRes.status).toBe(0);
        const plan = JSON.parse(planRes.stdout) as ScanPlan;
        const nm = plan.candidates.find((candidate) => candidate.name === "node_modules");
        expect(nm?.riskTier).toBe("safe");
        expect(plan.selectedCandidateIds).toContain(nm!.id);

        const cleanRes = runCli(
          ["clean", repo, "--engine", engine, "--yes", "--json"],
          buildEngineEnv(root, engine),
        );
        expect(cleanRes.status).toBe(0);
        expect(existsSync(nmFile)).toBe(false);
      }

      // Control 3: valid repo with deleted .git/index matches git (removable with git, unknown without git).
      const pathWithoutGit = buildPathWithoutGit(join(root, "no-git-bin"));
      for (const engine of ENGINES) {
        const repo = join(root, `deleted-index-${engine}`);
        initRepo(repo);
        const file = commitNodeModules(repo);
        unlinkSync(join(repo, ".git", "index"));

        // Without git on PATH: both engines mark unknown and refuse.
        assertProtectedAcrossAllRoutes({
          root,
          target: repo,
          committedFile: file,
          engine,
          expectedTier: "dangerous",
          expectedReason: "tracked-status-unknown",
          extraEnv: { PATH: pathWithoutGit },
        });

        // With git on PATH: matches `git ls-files --cached` (exit 0 empty) -> safe & removable.
        const planRes = runCli(
          ["plan", repo, "--engine", engine, "--json"],
          buildEngineEnv(root, engine),
        );
        expect(planRes.status).toBe(0);
        const plan = JSON.parse(planRes.stdout) as ScanPlan;
        const nm = plan.candidates.find((candidate) => candidate.name === "node_modules");
        expect(nm?.riskTier).toBe("safe");
        expect(plan.selectedCandidateIds).toContain(nm!.id);

        const cleanRes = runCli(
          ["clean", repo, "--engine", engine, "--yes", "--json"],
          buildEngineEnv(root, engine),
        );
        expect(cleanRes.status).toBe(0);
        expect(existsSync(file)).toBe(false);
      }
    },
    SAFETY_TEST_TIMEOUT_MS,
  );
});
