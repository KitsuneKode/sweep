import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "@kitsunekode/sweep-core/config";
import type { SweepConfig } from "@kitsunekode/sweep-protocol";
import { scanToPlan } from "@kitsunekode/sweep-core/engine";
import { assertSafeCwd } from "@kitsunekode/sweep-core/guardrails";
import {
  isRustEngineAvailable,
  resolveRustEngineBinary,
  scanToPlanViaRust,
} from "@kitsunekode/sweep-core/rust-engine";
import type { ScanPlan, SelectionPolicy } from "@kitsunekode/sweep-protocol";
import { DEFAULT_SELECTION_POLICY } from "@kitsunekode/sweep-protocol";
import { normalizePlan } from "../support/normalize-plan.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const FIXTURES_ROOT = join(REPO_ROOT, "tests/fixtures");
// The resolver picks the freshest workspace build, so pin the expectation to
// the same rule: a stale debug binary must not beat a newer release build.
const LOCAL_BINARY = ["debug", "release"]
  .map((profile) =>
    join(
      REPO_ROOT,
      "target",
      profile,
      process.platform === "win32" ? "sweep-engine.exe" : "sweep-engine",
    ),
  )
  .filter((path) => existsSync(path))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

interface FixtureRequest {
  exact?: boolean;
  selectionPolicy?: SelectionPolicy;
  /** Patterns merged on top of the defaults (opt-in/custom scan coverage). */
  extraPatterns?: string[];
}

/**
 * `SweepConfig.patterns` is the fully resolved list, so a fixture opts into
 * catalog/custom names by appending to `DEFAULT_CONFIG.patterns`.
 */
function fixtureConfig(request: FixtureRequest): SweepConfig {
  if (!request.extraPatterns?.length) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG,
    patterns: [...DEFAULT_CONFIG.patterns, ...request.extraPatterns],
  };
}

/**
 * Fixtures are committed to this repository, so scanned in place every
 * artifact in them is git-tracked - and sweep rightly blocks tracked content.
 * Scan a copy outside any repository, as a user's untracked build output.
 */
const STAGING_ROOT = mkdtempSync(join(tmpdir(), "sweep-contract-"));
afterAll(() => rmSync(STAGING_ROOT, { recursive: true, force: true }));
function stageFixture(name: string, source: string): string {
  const root = join(STAGING_ROOT, name);
  if (!existsSync(root)) {
    cpSync(source, root, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  }
  return root;
}

function loadFixtureCases(): Array<{
  name: string;
  root: string;
  request: FixtureRequest;
  source: string;
}> {
  return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const root = join(FIXTURES_ROOT, entry.name);
      const requestPath = join(root, "request.json");
      const expectedPath = join(root, "expected.plan.json");
      if (!existsSync(requestPath) || !existsSync(expectedPath)) {
        return null;
      }

      const request = JSON.parse(readFileSync(requestPath, "utf8")) as FixtureRequest;
      // Goldens are read from the source; scans run against the staged copy.
      return { name: entry.name, root: stageFixture(entry.name, root), request, source: root };
    })
    .filter(
      (
        fixture,
      ): fixture is { name: string; root: string; request: FixtureRequest; source: string } =>
        Boolean(fixture),
    );
}

function rustAvailable(): boolean {
  return LOCAL_BINARY !== undefined;
}

function assertMatchesGolden(actual: ScanPlan, fixtureRoot: string, goldenRoot: string): void {
  expect(actual.targetIdentity).toBeDefined();
  for (const candidate of actual.candidates) expect(candidate.identity).toBeDefined();
  const expectedPath = join(goldenRoot, "expected.plan.json");
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as ScanPlan;
  expect(normalizePlan(actual, fixtureRoot)).toEqual(expected);
}

function assertByteParity(jsPlan: ScanPlan, rustPlan: ScanPlan): void {
  expect(rustPlan.targetIdentity).toEqual(jsPlan.targetIdentity);
  const jsByPath = new Map(jsPlan.candidates.map((candidate) => [candidate.path, candidate]));
  expect(rustPlan.candidates.length).toBe(jsPlan.candidates.length);

  for (const rustCandidate of rustPlan.candidates) {
    const jsCandidate = jsByPath.get(rustCandidate.path);
    expect(jsCandidate).toBeDefined();
    expect(rustCandidate.identity).toEqual(jsCandidate?.identity);
    expect(rustCandidate.worktreeOf).toBe(jsCandidate?.worktreeOf);
    expect(rustCandidate.worktreeState).toBe(jsCandidate?.worktreeState);
    const jsBytes = jsCandidate?.estimatedBytes ?? 0;
    const rustBytes = rustCandidate.estimatedBytes;
    const tolerance = Math.max(512, jsBytes * 0.15);
    expect(Math.abs(rustBytes - jsBytes)).toBeLessThanOrEqual(tolerance);
  }
}

function assertValidCreatedAt(plan: ScanPlan): void {
  expect(plan.createdAt).not.toBe("1970-01-01T00:00:00.000Z");
  expect(Number.isNaN(Date.parse(plan.createdAt))).toBe(false);
}

const NATIVE_AVAILABLE = rustAvailable();
if (process.env.SWEEP_REQUIRE_RUST_TESTS === "1" && !NATIVE_AVAILABLE) {
  throw new Error("Native coverage is required, but no usable Rust test engine is available");
}

describe("engine contract fixtures", () => {
  const fixtures = loadFixtureCases();

  test("fixture catalog is non-empty", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    test(`js engine: ${fixture.name}`, async () => {
      const options: { exact: boolean; selectionPolicy?: SelectionPolicy } = {
        exact: fixture.request.exact ?? false,
      };
      if (fixture.request.selectionPolicy) {
        options.selectionPolicy = fixture.request.selectionPolicy;
      }

      const { plan } = await scanToPlan(fixture.root, fixtureConfig(fixture.request), options);
      assertMatchesGolden(plan, fixture.root, fixture.source);
    });

    test.skipIf(!NATIVE_AVAILABLE)(`rust engine: ${fixture.name}`, async () => {
      expect(isRustEngineAvailable()).toBe(true);
      // rustAvailable() guarantees a local build exists.
      expect(resolveRustEngineBinary()).toBe(LOCAL_BINARY!);

      const plan = await scanToPlanViaRust(fixture.root, {
        config: fixtureConfig(fixture.request),
        selectionPolicy: fixture.request.selectionPolicy ?? DEFAULT_SELECTION_POLICY,
        exact: fixture.request.exact ?? false,
      });
      assertMatchesGolden(plan, fixture.root, fixture.source);
      assertValidCreatedAt(plan);
    });
  }

  for (const fixture of fixtures) {
    test.skipIf(!NATIVE_AVAILABLE)(
      `js and rust byte estimates stay within tolerance: ${fixture.name}`,
      async () => {
        const options = {
          exact: fixture.request.exact ?? false,
          selectionPolicy: fixture.request.selectionPolicy ?? DEFAULT_SELECTION_POLICY,
        };

        const { plan: jsPlan } = await scanToPlan(
          fixture.root,
          fixtureConfig(fixture.request),
          options,
        );
        const rustPlan = await scanToPlanViaRust(fixture.root, {
          config: fixtureConfig(fixture.request),
          ...options,
        });

        assertByteParity(jsPlan, rustPlan);
      },
    );
  }

  test.skipIf(!NATIVE_AVAILABLE)("rust engine rejects shallow guardrail targets", async () => {
    await expect(
      scanToPlanViaRust("/tmp", {
        config: DEFAULT_CONFIG,
        selectionPolicy: DEFAULT_SELECTION_POLICY,
      }),
    ).rejects.toThrow();
  });

  test.skipIf(!NATIVE_AVAILABLE)(
    "rust progressive hooks emit candidates before sizing completes",
    async () => {
      const basicFixture = fixtures.find((fixture) => fixture.name === "basic");
      if (!basicFixture) throw new Error("required basic parity fixture is missing");

      const order: string[] = [];
      await scanToPlanViaRust(basicFixture.root, {
        config: DEFAULT_CONFIG,
        selectionPolicy: DEFAULT_SELECTION_POLICY,
        onEntry: () => {
          order.push("entry");
        },
        onEntrySized: () => {
          order.push("sized");
        },
      });

      expect(order.length).toBeGreaterThan(0);
      expect(order.indexOf("entry")).toBeLessThan(order.indexOf("sized"));
    },
  );

  test.skipIf(!NATIVE_AVAILABLE)("rust exact sizing marks plan summary as exact", async () => {
    const basicFixture = fixtures.find((fixture) => fixture.name === "basic");
    if (!basicFixture) throw new Error("required basic parity fixture is missing");

    const plan = await scanToPlanViaRust(basicFixture.root, {
      config: DEFAULT_CONFIG,
      selectionPolicy: DEFAULT_SELECTION_POLICY,
      exact: true,
    });

    expect(plan.summary.exact).toBe(true);
  });

  test.skipIf(!NATIVE_AVAILABLE)(
    "non-streamed rust plan applies workspace-stub enrichment like js",
    async () => {
      // One-shot (no hooks) rust plans used to skip enrichCandidates entirely:
      // a tiny peer node_modules next to a real install must demote to
      // caution and leave the default selection on both engines.
      const root = mkdtempSync(join(tmpdir(), "sweep-stub-parity-"));
      try {
        mkdirSync(join(root, "a", "node_modules"), { recursive: true });
        writeFileSync(join(root, "a", "node_modules", "fat.bin"), Buffer.alloc(2 * 1024 * 1024));
        mkdirSync(join(root, "b", "node_modules"), { recursive: true });
        writeFileSync(join(root, "b", "node_modules", "tiny.bin"), Buffer.alloc(128));

        const { plan: jsPlan } = await scanToPlan(root, DEFAULT_CONFIG, { exact: false });
        const rustPlan = await scanToPlanViaRust(root, {
          config: DEFAULT_CONFIG,
          selectionPolicy: DEFAULT_SELECTION_POLICY,
        });
        const jsStub = jsPlan.candidates.find((c) => c.path.includes("/b/"));
        const rustStub = rustPlan.candidates.find((c) => c.path.includes("/b/"));

        expect(rustStub?.riskTier).toBe(jsStub?.riskTier);
        expect(rustStub?.reasons).toEqual(jsStub?.reasons);
        expect(rustPlan.selectedCandidateIds.sort()).toEqual(jsPlan.selectedCandidateIds.sort());
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("rust SweepConfig forwarding", () => {
  let tempRoot: string;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  test.skipIf(!NATIVE_AVAILABLE)(
    "rust honors --pattern, --ignore, and --depth parity with JS",
    async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "sweep-config-parity-"));
      mkdirSync(join(tempRoot, "node_modules"));
      mkdirSync(join(tempRoot, "custom-artifact"));
      mkdirSync(join(tempRoot, "a", "nested-dist"), { recursive: true });
      mkdirSync(join(tempRoot, "packages", "vendor", "dist"), { recursive: true });

      const config = {
        ...DEFAULT_CONFIG,
        patterns: [...DEFAULT_CONFIG.patterns, "custom-artifact"],
        ignore: ["packages/vendor"],
        depth: 0,
      };

      const options = {
        selectionPolicy: DEFAULT_SELECTION_POLICY,
        exact: false,
      };

      const { plan: jsPlan } = await scanToPlan(tempRoot, config, options);
      const rustPlan = await scanToPlanViaRust(tempRoot, { config, ...options });

      const jsNames = jsPlan.candidates.map((candidate) => candidate.name).sort();
      const rustNames = rustPlan.candidates.map((candidate) => candidate.name).sort();
      expect(rustNames).toEqual(jsNames);
      expect(rustNames).toContain("custom-artifact");
      expect(rustNames).toContain("node_modules");
      expect(rustNames).not.toContain("dist");
    },
  );

  // Windows names are UTF-16 - raw invalid bytes only exist on unix filesystems.
  test.skipIf(process.platform === "win32" || !NATIVE_AVAILABLE)(
    "non-UTF8 dir names: both engines count the undescendable dir as skipped",
    async () => {
      tempRoot = mkdtempSync(join(tmpdir(), "sweep-utf8-parity-"));
      // mkdirSync accepts Buffer paths; the U+FFFD-mangled name readdir returns
      // cannot address this dir, so both levels are created from raw bytes.
      const weird = Buffer.concat([Buffer.from(`${tempRoot}/`), Buffer.from([0xff, 0xfe])]);
      mkdirSync(weird);
      mkdirSync(Buffer.concat([weird, Buffer.from("/node_modules")]));

      const { plan: jsPlan } = await scanToPlan(tempRoot, DEFAULT_CONFIG, {
        selectionPolicy: DEFAULT_SELECTION_POLICY,
        exact: false,
      });
      const rustPlan = await scanToPlanViaRust(tempRoot, {
        config: DEFAULT_CONFIG,
        selectionPolicy: DEFAULT_SELECTION_POLICY,
        exact: false,
      });

      // The mangled name cannot be lstat'd, so neither engine descends - the
      // parity contract is that both report it the same way: zero candidates,
      // one skipped dir.
      expect(jsPlan.candidates).toHaveLength(0);
      expect(rustPlan.candidates).toHaveLength(0);
      expect(rustPlan.summary.skippedDirs).toBe(jsPlan.summary.skippedDirs);
      expect(jsPlan.summary.skippedDirs).toBe(1);
    },
  );
});

test.skipIf(!NATIVE_AVAILABLE)("direct native errors escape terminal control sequences", () => {
  const proc = Bun.spawnSync({
    cmd: [LOCAL_BINARY!, "scan", "/tmp/native\x1b]52;c;payload\x07/.git"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).not.toBe(0);
  const stderr = Buffer.from(proc.stderr).toString("utf8");
  expect(stderr).not.toContain("\x1b");
  expect(stderr).not.toContain("\x07");
  expect(stderr).toContain("payload");
});

test.skipIf(!NATIVE_AVAILABLE)(
  "native refreshed-size refusal is explicit and leaves all files untouched",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-native-refusal-"));
    try {
      const target = join(root, "project");
      mkdirSync(join(target, "node_modules"), { recursive: true });
      writeFileSync(join(target, "node_modules", "keep"), "preserve");
      const { plan } = await scanToPlan(target, DEFAULT_CONFIG);
      const { applyPlanViaRust } = await import("@kitsunekode/sweep-core/rust-engine");
      await expect(applyPlanViaRust(plan, undefined, undefined, 0)).rejects.toMatchObject({
        applyOutcome: "not_started",
        refusalCode: "size_limit_exceeded",
      });
      expect(readFileSync(join(target, "node_modules", "keep"), "utf8")).toBe("preserve");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!NATIVE_AVAILABLE)(
  "both engines match absolute file bytes and mtime rather than normalized goldens",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-ground-truth-"));
    try {
      const file = join(root, "tsconfig.tsbuildinfo");
      const contents = Buffer.alloc(8377, 42);
      writeFileSync(file, contents);
      const modified = new Date("2026-01-02T03:04:05.000Z");
      utimesSync(file, modified, modified);
      const metadata = statSync(file, { bigint: true });
      const { plan: jsPlan } = await scanToPlan(root, DEFAULT_CONFIG);
      const rustPlan = await scanToPlanViaRust(root, {
        config: DEFAULT_CONFIG,
        selectionPolicy: DEFAULT_SELECTION_POLICY,
      });
      for (const plan of [jsPlan, rustPlan]) {
        expect(plan.candidates).toHaveLength(1);
        const candidate = plan.candidates[0]!;
        expect(candidate.path).toBe(file);
        expect(candidate.estimatedBytes).toBe(contents.length);
        expect(candidate.bytesKnown).not.toBe(false);
        expect(candidate.modifiedMs).toBe(Number(metadata.mtimeMs));
        expect(candidate.identity?.device).toBe(metadata.dev.toString());
        expect(candidate.identity?.inode).toBe(metadata.ino.toString());
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!NATIVE_AVAILABLE || spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0)(
  "both engines emit identical canonical worktreeOf and worktreeState before plan normalization",
  async () => {
    const rawRoot = mkdtempSync(join(tmpdir(), "sweep-worktree-parity-"));
    const canonical = (p: string) => {
      const real =
        typeof realpathSync.native === "function" ? realpathSync.native(p) : realpathSync(p);
      if (process.platform !== "win32") return real;
      if (real.startsWith("\\\\?\\UNC\\")) return `\\\\${real.slice(8)}`;
      if (real.startsWith("\\\\?\\")) return real.slice(4);
      return real;
    };
    const root = canonical(rawRoot);
    const emptyCfg = join(root, ".empty-gitconfig");
    writeFileSync(emptyCfg, "");
    const gitEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^git_/i.test(k)) gitEnv[k] = v;
    }
    gitEnv.GIT_CONFIG_GLOBAL = emptyCfg;
    gitEnv.GIT_CONFIG_NOSYSTEM = "1";
    gitEnv.GIT_AUTHOR_NAME = "t";
    gitEnv.GIT_AUTHOR_EMAIL = "t@example.com";
    gitEnv.GIT_COMMITTER_NAME = "t";
    gitEnv.GIT_COMMITTER_EMAIL = "t@example.com";
    gitEnv.LC_ALL = "C";

    const git = (cwd: string, ...args: string[]) => {
      const res = spawnSync("git", ["-C", cwd, ...args], {
        env: gitEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
      return res.stdout.trim();
    };
    const commit = (cwd: string, file: string, content = `${file}\n`) => {
      writeFileSync(join(cwd, file), content);
      git(cwd, "add", file);
      git(cwd, "-c", "commit.gpgsign=false", "commit", "-q", "-m", file);
    };
    const settle = (wt: string) => {
      const past = new Date(Date.now() - 5_000);
      for (const rel of git(wt, "ls-files")
        .split(/\r?\n/)
        .filter((line) => line.length > 0)) {
        const abs = join(wt, rel);
        try {
          if (!lstatSync(abs).isSymbolicLink()) utimesSync(abs, past, past);
        } catch {
          // Ignore missing entries.
        }
      }
      git(wt, "update-index", "--refresh");
    };
    const seedModules = (dir: string) => {
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    };

    try {
      const remote = join(root, "remote.git");
      const app = join(root, "app");
      mkdirSync(app);
      git(root, "init", "-q", "--bare", remote);
      git(app, "init", "-q", "-b", "main");
      git(app, "config", "core.autocrlf", "false");
      commit(app, ".gitignore", "node_modules/\n");
      git(app, "remote", "add", "origin", remote);
      git(app, "push", "-q", "-u", "origin", "main");
      git(app, "remote", "set-head", "origin", "main");

      // 1. Clean settled merged worktree -> merged
      const merged = join(root, "wt-merged");
      git(app, "worktree", "add", "-q", "-b", "wt-merged", merged);
      commit(merged, "merged.txt");
      settle(merged);
      git(app, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "m", "wt-merged");
      git(app, "push", "-q", "origin", "main");

      // 2. Open worktree -> undefined
      const open = join(root, "wt-open");
      git(app, "worktree", "add", "-q", "-b", "wt-open", open);
      commit(open, "wip.txt");
      settle(open);

      // 3. Merged branch whose upstream was deleted & pruned -> upstream_gone (never merged)
      const mergedGone = join(root, "wt-merged-gone");
      git(app, "worktree", "add", "-q", "-b", "wt-merged-gone", mergedGone);
      commit(mergedGone, "mg.txt");
      settle(mergedGone);
      git(mergedGone, "push", "-q", "-u", "origin", "wt-merged-gone");
      git(
        app,
        "-c",
        "commit.gpgsign=false",
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "mg",
        "wt-merged-gone",
      );
      git(app, "push", "-q", "origin", "main");
      git(app, "push", "-q", "origin", "--delete", "wt-merged-gone");
      git(app, "fetch", "-q", "--prune");

      // 4. Dirty merged worktree (non-ignored untracked file) -> undefined
      const dirty = join(root, "wt-dirty");
      git(app, "worktree", "add", "-q", "-b", "wt-dirty", dirty);
      commit(dirty, "dirty.txt");
      settle(dirty);
      git(app, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "md", "wt-dirty");
      git(app, "push", "-q", "origin", "main");
      writeFileSync(join(dirty, "untracked.txt"), "wip\n");

      // 5. Zero-commit branch forked from merged side branch -> undefined
      const zeroOnSide = join(root, "wt-zero-on-side");
      git(app, "worktree", "add", "-q", "-b", "wt-zero-on-side", zeroOnSide, "wt-merged");
      settle(zeroOnSide);

      // 6. Reviewer ignore-edge fixtures (embedded **, escaped wildcard, unclosed class, reversed range)
      const wtDoubleStar = join(root, "wt-double-star");
      git(app, "worktree", "add", "-q", "-b", "wt-double-star", wtDoubleStar);
      commit(wtDoubleStar, ".gitignore", "node_modules/\nout/file**.log\n");
      settle(wtDoubleStar);
      git(
        app,
        "-c",
        "commit.gpgsign=false",
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "ds",
        "wt-double-star",
      );
      git(app, "push", "-q", "origin", "main");
      mkdirSync(join(wtDoubleStar, "out", "files"), { recursive: true });
      writeFileSync(join(wtDoubleStar, "out", "files", "debug.log"), "dirty\n");

      const wtEscaped = join(root, "wt-escaped");
      git(app, "worktree", "add", "-q", "-b", "wt-escaped", wtEscaped);
      commit(wtEscaped, ".gitignore", "node_modules/\nliteral\\*.txt\n");
      settle(wtEscaped);
      git(app, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "ew", "wt-escaped");
      git(app, "push", "-q", "origin", "main");
      writeFileSync(join(wtEscaped, "literal.txt"), "dirty\n");

      const wtUnclosed = join(root, "wt-unclosed");
      git(app, "worktree", "add", "-q", "-b", "wt-unclosed", wtUnclosed);
      commit(wtUnclosed, ".gitignore", "node_modules/\n[abc\n");
      settle(wtUnclosed);
      git(app, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "uc", "wt-unclosed");
      git(app, "push", "-q", "origin", "main");
      writeFileSync(join(wtUnclosed, "[abc"), "dirty\n");

      const wtReversed = join(root, "wt-reversed");
      git(app, "worktree", "add", "-q", "-b", "wt-reversed", wtReversed);
      commit(wtReversed, ".gitignore", "node_modules/\n[z-a]\n");
      settle(wtReversed);
      git(app, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "rr", "wt-reversed");
      git(app, "push", "-q", "origin", "main");
      writeFileSync(join(wtReversed, "extra.txt"), "dirty\n");

      // 7. Racily-clean (same-second) entry -> undefined
      const wtRacy = join(root, "wt-racy");
      git(app, "worktree", "add", "-q", "-b", "wt-racy", wtRacy);
      commit(wtRacy, "racy.txt");
      git(app, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "racy", "wt-racy");
      git(app, "push", "-q", "origin", "main");

      // 8. Included origin config (separate repo, no origin/HEAD) -> undefined
      const incApp = join(root, "app-inc");
      mkdirSync(incApp);
      git(incApp, "init", "-q", "-b", "main");
      git(incApp, "config", "core.autocrlf", "false");
      commit(incApp, ".gitignore", "node_modules/\n");
      const incCfg = join(root, "inc-origin.gitconfig");
      writeFileSync(incCfg, '[REMOTE "origin"]\n\turl = /nonexistent/remote.git\n');
      git(incApp, "config", "include.path", incCfg);
      const wtInc = join(root, "wt-inc");
      git(incApp, "worktree", "add", "-q", "-b", "wt-inc", wtInc);
      commit(wtInc, "inc.txt");
      settle(wtInc);
      git(incApp, "merge", "-q", "--ff-only", "wt-inc");

      // 9. Reflogs disabled repo -> undefined
      const noReflogApp = join(root, "app-noreflog");
      mkdirSync(noReflogApp);
      git(noReflogApp, "init", "-q", "-b", "main");
      git(noReflogApp, "config", "core.autocrlf", "false");
      git(noReflogApp, "config", "core.logAllRefUpdates", "false");
      commit(noReflogApp, ".gitignore", "node_modules/\n");
      const wtNoReflog = join(root, "wt-noreflog");
      git(noReflogApp, "worktree", "add", "-q", "-b", "wt-noreflog", wtNoReflog);
      commit(wtNoReflog, "nr.txt");
      settle(wtNoReflog);
      git(
        noReflogApp,
        "-c",
        "commit.gpgsign=false",
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "nr",
        "wt-noreflog",
      );

      // 10. CRLF with core.autocrlf=true:
      //     - settled, non-racy, stat-matching merged tree -> merged
      //     - same tree with one modified file -> undefined
      //     - same tree racily-clean (same-second) -> undefined
      const crlfApp = join(root, "app-crlf");
      mkdirSync(crlfApp);
      git(crlfApp, "init", "-q", "-b", "main");
      git(crlfApp, "config", "core.autocrlf", "true");
      commit(crlfApp, ".gitignore", "node_modules/\n");
      const wtCrlf = join(root, "wt-crlf");
      git(crlfApp, "worktree", "add", "-q", "-b", "wt-crlf", wtCrlf);
      commit(wtCrlf, "crlf.txt", "a\r\nb\r\n");
      settle(wtCrlf);
      git(crlfApp, "merge", "-q", "--ff-only", "wt-crlf");

      const wtCrlfModified = join(root, "wt-crlf-modified");
      git(crlfApp, "worktree", "add", "-q", "-b", "wt-crlf-modified", wtCrlfModified);
      commit(wtCrlfModified, "crlf-mod.txt", "a\r\nb\r\n");
      settle(wtCrlfModified);
      git(crlfApp, "merge", "-q", "--ff-only", "wt-crlf-modified");
      writeFileSync(join(wtCrlfModified, "crlf-mod.txt"), "a\r\nB\r\n");

      const wtCrlfRacy = join(root, "wt-crlf-racy");
      git(crlfApp, "worktree", "add", "-q", "-b", "wt-crlf-racy", wtCrlfRacy);
      commit(wtCrlfRacy, "crlf-racy.txt", "a\r\nb\r\n");
      const racyGitDir = git(wtCrlfRacy, "rev-parse", "--git-dir");
      const racyStat = lstatSync(join(wtCrlfRacy, "crlf-racy.txt"));
      utimesSync(join(racyGitDir, "index"), racyStat.atime, racyStat.mtime);
      git(crlfApp, "merge", "-q", "--ff-only", "wt-crlf-racy");

      // 11. Required clean filter (never executes!) -> undefined
      const filterMarker = join(root, "CONTRACT_FILTER_RAN");
      const filterApp = join(root, "app-filter");
      mkdirSync(filterApp);
      git(filterApp, "init", "-q", "-b", "main");
      git(filterApp, "config", "core.autocrlf", "false");
      commit(filterApp, ".gitignore", "node_modules/\n");
      const wtFilter = join(root, "wt-filter");
      git(filterApp, "worktree", "add", "-q", "-b", "wt-filter", wtFilter);
      commit(wtFilter, ".gitattributes", "*.dat filter=reqclean\n");
      commit(wtFilter, "item.dat", "raw\n");
      settle(wtFilter);
      git(filterApp, "merge", "-q", "--ff-only", "wt-filter");
      git(filterApp, "config", "filter.reqclean.required", "true");
      git(filterApp, "config", "filter.reqclean.clean", `touch ${filterMarker}`);

      // 12. working-tree-encoding attribute -> undefined
      const encApp = join(root, "app-enc");
      mkdirSync(encApp);
      git(encApp, "init", "-q", "-b", "main");
      git(encApp, "config", "core.autocrlf", "false");
      commit(encApp, ".gitignore", "node_modules/\n");
      const wtEnc = join(root, "wt-enc");
      git(encApp, "worktree", "add", "-q", "-b", "wt-enc", wtEnc);
      commit(wtEnc, ".gitattributes", "*.enc working-tree-encoding=UTF-16LE-BOM\n");
      writeFileSync(join(wtEnc, "item.enc"), Buffer.from("\ufeffok\n", "utf16le"));
      git(wtEnc, "add", "item.enc");
      git(wtEnc, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "item.enc");
      settle(wtEnc);
      git(encApp, "merge", "-q", "--ff-only", "wt-enc");

      // 13. Coarse-timestamp index (mtime ns = 0, ctime sec/ns = 0) and touch -r
      //     mtime-restored same-size edits (both engines must agree).
      const patchIndexStat = (
        indexPath: string,
        targetPath: string,
        patch: { mtimeSec?: number; mtimeNsec?: number; ctimeSec?: number; ctimeNsec?: number },
      ) => {
        const buf = Buffer.from(readFileSync(indexPath));
        const count = buf.readUInt32BE(8);
        let at = 12;
        for (let i = 0; i < count; i++) {
          const start = at;
          const flags = buf.readUInt16BE(start + 60);
          const nameStart = start + 62 + ((flags & 0x4000) !== 0 ? 2 : 0);
          const nul = buf.indexOf(0, nameStart);
          const entryPath = buf.subarray(nameStart, nul).toString("utf8");
          if (entryPath === targetPath) {
            if (patch.ctimeSec !== undefined) buf.writeUInt32BE(patch.ctimeSec >>> 0, start);
            if (patch.ctimeNsec !== undefined) buf.writeUInt32BE(patch.ctimeNsec >>> 0, start + 4);
            if (patch.mtimeSec !== undefined) buf.writeUInt32BE(patch.mtimeSec >>> 0, start + 8);
            if (patch.mtimeNsec !== undefined) buf.writeUInt32BE(patch.mtimeNsec >>> 0, start + 12);
          }
          const fixed = nameStart - start;
          at = start + ((fixed + (nul - nameStart) + 8) & ~7);
        }
        const payloadEnd = buf.length - 20;
        createHash("sha1").update(buf.subarray(0, payloadEnd)).digest().copy(buf, payloadEnd);
        writeFileSync(indexPath, buf);
      };

      const evenPastSec = Math.floor((Date.now() - 10_000) / 2000) * 2;
      const evenPastDate = new Date(evenPastSec * 1000);

      const wtCoarseEdited = join(root, "wt-coarse-edited");
      git(app, "worktree", "add", "-q", "-b", "wt-coarse-edited", wtCoarseEdited);
      commit(wtCoarseEdited, "coarse-edited.txt", "hello world\n");
      settle(wtCoarseEdited);
      git(
        app,
        "-c",
        "commit.gpgsign=false",
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "ce",
        "wt-coarse-edited",
      );
      git(app, "push", "-q", "origin", "main");
      const coarseEditedFile = join(wtCoarseEdited, "coarse-edited.txt");
      utimesSync(coarseEditedFile, evenPastDate, evenPastDate);
      git(wtCoarseEdited, "update-index", "--refresh");
      patchIndexStat(
        join(git(wtCoarseEdited, "rev-parse", "--git-dir"), "index"),
        "coarse-edited.txt",
        {
          mtimeSec: evenPastSec,
          mtimeNsec: 0,
          ctimeSec: 0,
          ctimeNsec: 0,
        },
      );
      writeFileSync(coarseEditedFile, "hello WORLD\n");
      utimesSync(coarseEditedFile, evenPastDate, evenPastDate);

      const wtCoarseClean = join(root, "wt-coarse-clean");
      git(app, "worktree", "add", "-q", "-b", "wt-coarse-clean", wtCoarseClean);
      commit(wtCoarseClean, "coarse-clean.txt", "hello world\n");
      settle(wtCoarseClean);
      git(
        app,
        "-c",
        "commit.gpgsign=false",
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "cc",
        "wt-coarse-clean",
      );
      git(app, "push", "-q", "origin", "main");
      const coarseCleanFile = join(wtCoarseClean, "coarse-clean.txt");
      utimesSync(coarseCleanFile, evenPastDate, evenPastDate);
      git(wtCoarseClean, "update-index", "--refresh");
      patchIndexStat(
        join(git(wtCoarseClean, "rev-parse", "--git-dir"), "index"),
        "coarse-clean.txt",
        {
          mtimeSec: evenPastSec,
          mtimeNsec: 0,
          ctimeSec: 0,
          ctimeNsec: 0,
        },
      );

      const wtCoarseRacy2s = join(root, "wt-coarse-racy-2s");
      git(app, "worktree", "add", "-q", "-b", "wt-coarse-racy-2s", wtCoarseRacy2s);
      commit(wtCoarseRacy2s, "coarse-racy.txt", "hello world\n");
      settle(wtCoarseRacy2s);
      git(
        app,
        "-c",
        "commit.gpgsign=false",
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "cr",
        "wt-coarse-racy-2s",
      );
      git(app, "push", "-q", "origin", "main");
      const coarseRacyFile = join(wtCoarseRacy2s, "coarse-racy.txt");
      const coarseRacyIndex = join(git(wtCoarseRacy2s, "rev-parse", "--git-dir"), "index");
      const coarseIdxSec = Number(
        (lstatSync(coarseRacyIndex, { bigint: true }).mtimeNs / 1_000_000_000n) & 0xffffffffn,
      );
      const coarseBucketSec = coarseIdxSec - 1;
      const coarseBucketDate = new Date(coarseBucketSec * 1000);
      utimesSync(coarseRacyFile, coarseBucketDate, coarseBucketDate);
      git(wtCoarseRacy2s, "update-index", "--refresh");
      patchIndexStat(coarseRacyIndex, "coarse-racy.txt", {
        mtimeSec: coarseBucketSec,
        mtimeNsec: 0,
        ctimeSec: 0,
        ctimeNsec: 0,
      });
      utimesSync(
        coarseRacyIndex,
        new Date(coarseIdxSec * 1000 + 6),
        new Date(coarseIdxSec * 1000 + 6),
      );

      const wtTouchR = join(root, "wt-touch-r");
      git(app, "worktree", "add", "-q", "-b", "wt-touch-r", wtTouchR);
      commit(wtTouchR, "touch-r.txt", "hello world\n");
      settle(wtTouchR);
      git(app, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "tr", "wt-touch-r");
      git(app, "push", "-q", "origin", "main");
      const touchRFile = join(wtTouchR, "touch-r.txt");
      const touchRBefore = lstatSync(touchRFile);
      writeFileSync(touchRFile, "hello WORLD\n");
      utimesSync(touchRFile, touchRBefore.atime, touchRBefore.mtime);

      for (const dir of [
        app,
        merged,
        open,
        mergedGone,
        dirty,
        zeroOnSide,
        wtDoubleStar,
        wtEscaped,
        wtUnclosed,
        wtReversed,
        wtRacy,
        wtInc,
        wtNoReflog,
        wtCrlf,
        wtCrlfModified,
        wtCrlfRacy,
        wtFilter,
        wtEnc,
        wtCoarseEdited,
        wtCoarseClean,
        wtCoarseRacy2s,
        wtTouchR,
      ]) {
        seedModules(dir);
      }

      const { plan: jsPlan } = await scanToPlan(root, DEFAULT_CONFIG);
      const rustPlan = await scanToPlanViaRust(root, {
        config: DEFAULT_CONFIG,
        selectionPolicy: DEFAULT_SELECTION_POLICY,
      });

      const byWorktree = (plan: ScanPlan) =>
        new Map(
          plan.candidates.map((c) => [
            canonical(c.path),
            { worktreeOf: c.worktreeOf, worktreeState: c.worktreeState },
          ]),
        );

      const jsMap = byWorktree(jsPlan);
      const rustMap = byWorktree(rustPlan);
      expect(rustMap.size).toBe(jsMap.size);
      expect(rustMap).toEqual(jsMap);
      expect(existsSync(filterMarker)).toBe(false);

      expect(jsMap.get(canonical(join(app, "node_modules")))).toEqual({
        worktreeOf: undefined,
        worktreeState: undefined,
      });
      expect(jsMap.get(canonical(join(merged, "node_modules")))).toEqual({
        worktreeOf: app,
        worktreeState: "merged",
      });
      expect(jsMap.get(canonical(join(open, "node_modules")))).toEqual({
        worktreeOf: app,
        worktreeState: undefined,
      });
      expect(jsMap.get(canonical(join(mergedGone, "node_modules")))).toEqual({
        worktreeOf: app,
        worktreeState: "upstream_gone",
      });
      for (const unknownWt of [
        dirty,
        zeroOnSide,
        wtDoubleStar,
        wtEscaped,
        wtUnclosed,
        wtReversed,
        wtRacy,
      ]) {
        expect(jsMap.get(canonical(join(unknownWt, "node_modules")))).toEqual({
          worktreeOf: app,
          worktreeState: undefined,
        });
      }
      expect(jsMap.get(canonical(join(wtInc, "node_modules")))).toEqual({
        worktreeOf: incApp,
        worktreeState: undefined,
      });
      expect(jsMap.get(canonical(join(wtNoReflog, "node_modules")))).toEqual({
        worktreeOf: noReflogApp,
        worktreeState: undefined,
      });
      expect(jsMap.get(canonical(join(wtCrlf, "node_modules")))).toEqual({
        worktreeOf: crlfApp,
        worktreeState: "merged",
      });
      expect(jsMap.get(canonical(join(wtCrlfModified, "node_modules")))).toEqual({
        worktreeOf: crlfApp,
        worktreeState: undefined,
      });
      expect(jsMap.get(canonical(join(wtCrlfRacy, "node_modules")))).toEqual({
        worktreeOf: crlfApp,
        worktreeState: undefined,
      });
      expect(jsMap.get(canonical(join(wtFilter, "node_modules")))).toEqual({
        worktreeOf: filterApp,
        worktreeState: undefined,
      });
      expect(jsMap.get(canonical(join(wtEnc, "node_modules")))).toEqual({
        worktreeOf: encApp,
        worktreeState: undefined,
      });
      expect(jsMap.get(canonical(join(wtCoarseEdited, "node_modules")))).toEqual({
        worktreeOf: app,
        worktreeState: undefined,
      });
      expect(jsMap.get(canonical(join(wtCoarseClean, "node_modules")))).toEqual({
        worktreeOf: app,
        worktreeState: "merged",
      });
      expect(jsMap.get(canonical(join(wtCoarseRacy2s, "node_modules")))).toEqual({
        worktreeOf: app,
        worktreeState: undefined,
      });
      expect(jsMap.get(canonical(join(wtTouchR, "node_modules")))).toEqual({
        worktreeOf: app,
        worktreeState: undefined,
      });
    } finally {
      rmSync(rawRoot, { recursive: true, force: true });
    }
  },
);

test.skipIf(!NATIVE_AVAILABLE)(
  "both engines agree on .app project folders vs macOS bundles and prefix-blocked OS roots",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-app-parity-"));
    try {
      mkdirSync(join(root, "example.app", "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(root, "example.app", "node_modules", "pkg", "index.js"), "export {};\n");
      mkdirSync(join(root, "Editor.app", "Contents", "Resources", "app", "node_modules", "pkg"), {
        recursive: true,
      });
      writeFileSync(join(root, "Editor.app", "Contents", "Info.plist"), "<plist/>\n");
      writeFileSync(
        join(root, "Editor.app", "Contents", "Resources", "app", "node_modules", "pkg", "index.js"),
        "export {};\n",
      );

      const { plan: jsPlan } = await scanToPlan(root, DEFAULT_CONFIG);
      const rustPlan = await scanToPlanViaRust(root, {
        config: DEFAULT_CONFIG,
        selectionPolicy: DEFAULT_SELECTION_POLICY,
      });
      expect(normalizePlan(rustPlan, root)).toEqual(normalizePlan(jsPlan, root));

      const bySuffix = (plan: ScanPlan, suffix: string) =>
        plan.candidates.find((c) => c.path.endsWith(suffix));
      for (const plan of [jsPlan, rustPlan]) {
        const project = bySuffix(plan, join("example.app", "node_modules"));
        expect(project?.riskTier).toBe("safe");
        const bundle = bySuffix(plan, join("Resources", "app", "node_modules"));
        if (process.platform === "darwin") {
          expect(bundle?.riskTier).toBe("dangerous");
          expect(bundle?.reasons).toContain("tool-home");
        } else {
          expect(bundle?.riskTier).toBe("safe");
        }
      }

      const refusedTarget =
        process.platform === "win32" ? "\\\\?\\C:\\Windows\\System32" : "/etc/systemd";
      expect(() => assertSafeCwd(refusedTarget)).toThrow(/protected path/i);
      await expect(
        scanToPlanViaRust(refusedTarget, {
          config: DEFAULT_CONFIG,
          selectionPolicy: DEFAULT_SELECTION_POLICY,
        }),
      ).rejects.toThrow(/protected path/i);

      if (process.platform !== "win32") {
        expect(() => assertSafeCwd("/run")).toThrow(/protected path/i);
        await expect(
          scanToPlanViaRust("/run", {
            config: DEFAULT_CONFIG,
            selectionPolicy: DEFAULT_SELECTION_POLICY,
          }),
        ).rejects.toThrow(/protected path/i);
        expect(() => assertSafeCwd("/run/media/u/Data/proj")).not.toThrow();
        expect(() => assertSafeCwd("/dev/shm/build")).not.toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!NATIVE_AVAILABLE)(
  "both engines agree on narrowed tool homes, worktree carve-outs, and cloud-sync notices",
  async () => {
    const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "sweep-home-parity-")));
    try {
      const makeProject = (...parts: string[]) => {
        const dir = join(fakeHome, ...parts, "node_modules", "pkg");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "index.js"), "export {};\n");
      };

      // Safe project roots (including narrowed/exempted tool homes and cloud-sync folders)
      makeProject("go", "src", "proj");
      makeProject(".t3", "worktrees", "x");
      makeProject(".codex", "worktrees", "x");
      makeProject("Dropbox", "proj");
      makeProject("OneDrive", "Documents", "proj");
      makeProject("OneDrive - Contoso", "proj");
      makeProject("Google Drive", "proj");
      makeProject("My Drive", "proj");

      // Protected tool homes
      makeProject("go", "pkg", "mod");
      makeProject(".t3", "userdata");
      makeProject(".codex", "skills");
      makeProject("Library", "CloudStorage", "GoogleDrive-me", "proj");

      // Scan each subtree under fakeHome in a child process so Bun's cached
      // os.homedir() and Rust's std::env::home_dir() both see the fake HOME.
      const roots = [
        "go",
        ".t3",
        ".codex",
        "Dropbox",
        "OneDrive",
        "OneDrive - Contoso",
        "Google Drive",
        "My Drive",
        "Library",
      ].map((name) => join(fakeHome, name));

      const script = [
        'import { DEFAULT_CONFIG } from "@kitsunekode/sweep-core/config";',
        'import { scanToPlan } from "@kitsunekode/sweep-core/engine";',
        'import { scanToPlanViaRust } from "@kitsunekode/sweep-core/rust-engine";',
        'import { DEFAULT_SELECTION_POLICY } from "@kitsunekode/sweep-protocol";',
        "const roots = JSON.parse(process.argv[1]);",
        "const js = [];",
        "const rust = [];",
        "for (const root of roots) {",
        "  const { plan: jsPlan } = await scanToPlan(root, DEFAULT_CONFIG);",
        "  const rustPlan = await scanToPlanViaRust(root, {",
        "    config: DEFAULT_CONFIG,",
        "    selectionPolicy: DEFAULT_SELECTION_POLICY,",
        "  });",
        "  js.push({ root, plan: jsPlan });",
        "  rust.push({ root, plan: rustPlan });",
        "}",
        "process.stdout.write(JSON.stringify({ js, rust }));",
      ].join("\n");

      const proc = Bun.spawnSync(["bun", "-e", script, JSON.stringify(roots)], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          SWEEP_CONFIG_DIR: join(fakeHome, ".sweep-config"),
          XDG_CONFIG_HOME: join(fakeHome, ".xdg"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) {
        throw new Error(
          `parity child failed (exit ${proc.exitCode}): ${Buffer.from(proc.stderr).toString("utf8")}`,
        );
      }
      const { js, rust } = JSON.parse(Buffer.from(proc.stdout).toString("utf8")) as {
        js: Array<{ root: string; plan: ScanPlan }>;
        rust: Array<{ root: string; plan: ScanPlan }>;
      };

      const allJs: ScanPlan["candidates"] = [];
      const allRust: ScanPlan["candidates"] = [];
      for (let i = 0; i < roots.length; i += 1) {
        const jsEntry = js[i]!;
        const rustEntry = rust[i]!;
        expect(normalizePlan(rustEntry.plan, jsEntry.root)).toEqual(
          normalizePlan(jsEntry.plan, jsEntry.root),
        );
        allJs.push(...jsEntry.plan.candidates);
        allRust.push(...rustEntry.plan.candidates);
      }

      const find = (candidates: ScanPlan["candidates"], ...parts: string[]) =>
        candidates.find((c) => c.path === join(fakeHome, ...parts, "node_modules"));

      for (const candidates of [allJs, allRust]) {
        for (const parts of [
          ["go", "src", "proj"],
          [".t3", "worktrees", "x"],
          [".codex", "worktrees", "x"],
        ]) {
          const cand = find(candidates, ...parts);
          expect(cand?.riskTier).toBe("safe");
          expect(cand?.selectedByDefault).toBe(true);
          expect(cand?.reasons).toEqual(["default-pattern"]);
        }

        for (const parts of [
          ["Dropbox", "proj"],
          ["OneDrive", "Documents", "proj"],
          ["OneDrive - Contoso", "proj"],
          ["Google Drive", "proj"],
          ["My Drive", "proj"],
        ]) {
          const cand = find(candidates, ...parts);
          expect(cand?.riskTier).toBe("safe");
          expect(cand?.selectedByDefault).toBe(true);
          expect(cand?.reasons).toEqual(["default-pattern", "cloud-sync"]);
        }

        for (const parts of [
          ["go", "pkg", "mod"],
          [".t3", "userdata"],
          [".codex", "skills"],
        ]) {
          const cand = find(candidates, ...parts);
          expect(cand?.riskTier).toBe("dangerous");
          expect(cand?.selectedByDefault).toBe(false);
          expect(cand?.reasons).toEqual(["default-pattern", "tool-home"]);
        }

        const cloudStorage = find(candidates, "Library", "CloudStorage", "GoogleDrive-me", "proj");
        expect(cloudStorage?.riskTier).toBe("dangerous");
        expect(cloudStorage?.selectedByDefault).toBe(false);
        expect(cloudStorage?.reasons).toEqual(["default-pattern", "tool-home", "cloud-sync"]);
      }
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  },
);

test.skipIf(!NATIVE_AVAILABLE)(
  "both engines report identical uniqueBytes and uniqueTotalBytes for pnpm/Bun hardlink stores",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-hardlink-parity-"));
    try {
      const store = join(root, "store");
      const scanTarget = join(root, "work");
      const nmA = join(scanTarget, "proj-a", "node_modules");
      const nmB = join(scanTarget, "proj-b", "node_modules");
      mkdirSync(store, { recursive: true });
      mkdirSync(nmA, { recursive: true });
      mkdirSync(nmB, { recursive: true });

      // External pnpm/Bun store file hardlinked into both node_modules (nlink = 3; 2 in scan).
      const storePkg = join(store, "pkg.js");
      writeFileSync(storePkg, "s".repeat(4096));
      linkSync(storePkg, join(nmA, "pkg.js"));
      linkSync(storePkg, join(nmB, "pkg.js"));

      // Cross-candidate hardlink only between proj-a and proj-b (nlink = 2; 2 in scan).
      const cross = join(nmA, "cross.js");
      writeFileSync(cross, "c".repeat(2048));
      linkSync(cross, join(nmB, "cross.js"));

      // Intra-candidate hardlink inside proj-a (nlink = 2; both in proj-a).
      const intra = join(nmA, "intra-1.js");
      writeFileSync(intra, "i".repeat(1024));
      linkSync(intra, join(nmA, "intra-2.js"));

      // Unique single-link files.
      writeFileSync(join(nmA, "own-a.js"), "a".repeat(500));
      writeFileSync(join(nmB, "own-b.js"), "b".repeat(300));

      const jsPlan = (await scanToPlan(scanTarget, DEFAULT_CONFIG)).plan;
      const rustPlan = await scanToPlanViaRust(scanTarget, {
        config: DEFAULT_CONFIG,
        selectionPolicy: DEFAULT_SELECTION_POLICY,
      });
      const rustStreamPlan = await scanToPlanViaRust(scanTarget, {
        config: DEFAULT_CONFIG,
        selectionPolicy: DEFAULT_SELECTION_POLICY,
        onEntry: () => {},
        onEntrySized: () => {},
      });

      const byRel = (plan: ScanPlan) =>
        new Map(
          plan.candidates.map((c) => [
            c.path.slice(scanTarget.length + 1).replaceAll("\\", "/"),
            { estimatedBytes: c.estimatedBytes, uniqueBytes: c.uniqueBytes },
          ]),
        );

      for (const plan of [jsPlan, rustPlan, rustStreamPlan]) {
        const map = byRel(plan);
        expect(map.get("proj-a/node_modules")).toEqual({
          estimatedBytes: 4096 + 2048 + 1024 + 500,
          uniqueBytes: 1024 + 500,
        });
        expect(map.get("proj-b/node_modules")).toEqual({
          estimatedBytes: 4096 + 2048 + 300,
          uniqueBytes: 300,
        });
        expect(plan.summary.estimatedTotalBytes).toBe(4096 * 2 + 2048 * 2 + 1024 + 500 + 300);
        // Unique across scan: intra (1024) + own-a (500) + own-b (300) + cross once (2048); storePkg (4096) excluded.
        expect(plan.summary.uniqueTotalBytes).toBe(1024 + 500 + 300 + 2048);
        expect(plan.summary.uniqueBytesPartial).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!NATIVE_AVAILABLE)(
  "both engines mark uniqueBytesPartial when hardlink tracking hits its cap",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-hardlink-cap-parity-"));
    try {
      const store = join(root, "store");
      const scanTarget = join(root, "work");
      const nmA = join(scanTarget, "proj-a", "node_modules");
      const nmB = join(scanTarget, "proj-b", "node_modules");
      mkdirSync(store, { recursive: true });
      mkdirSync(nmA, { recursive: true });
      mkdirSync(nmB, { recursive: true });

      // 16 distinct hardlinked store files exceed maxIdentities: 8 while
      // directory discovery (3 real dirs: work, proj-a, proj-b) stays well within it.
      for (let i = 0; i < 16; i += 1) {
        const src = join(store, `pkg-${i}.js`);
        writeFileSync(src, "s".repeat(512));
        linkSync(src, join(nmA, `pkg-${i}.js`));
        linkSync(src, join(nmB, `pkg-${i}.js`));
      }
      writeFileSync(join(nmA, "own-a.js"), "a".repeat(500));
      writeFileSync(join(nmB, "own-b.js"), "b".repeat(300));

      const limits = { maxIdentities: 8 };
      const jsPlan = (await scanToPlan(scanTarget, DEFAULT_CONFIG, { limits })).plan;
      const rustPlan = await scanToPlanViaRust(scanTarget, {
        config: DEFAULT_CONFIG,
        selectionPolicy: DEFAULT_SELECTION_POLICY,
        limits,
      });
      const rustStreamPlan = await scanToPlanViaRust(scanTarget, {
        config: DEFAULT_CONFIG,
        selectionPolicy: DEFAULT_SELECTION_POLICY,
        limits,
        onEntry: () => {},
        onEntrySized: () => {},
      });

      for (const plan of [jsPlan, rustPlan, rustStreamPlan]) {
        expect(plan.summary.uniqueBytesPartial).toBe(true);
        expect(plan.summary.uniqueTotalBytes).toBe(500 + 300);
        expect(plan.summary.estimatedTotalBytes).toBe(16 * 512 * 2 + 500 + 300);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
