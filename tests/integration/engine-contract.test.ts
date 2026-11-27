import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
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
