import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "./config.js";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ScanPlan } from "@kitsunekode/sweep-protocol";
import { DiscoveryIndexError, DiscoveryIndexSession } from "./discovery-index.js";
import { gitTrackedPathsViaEngine } from "./git-tracked.js";
import { ApplyRefusedError } from "./guardrails.js";
import {
  applyPlanViaRust,
  isRustEngineAvailable,
  lookupExecutable,
  probeRustEngine,
  rustScanBlockedReason,
  scanToPlanViaRust,
  windowsShellFreeExtensions,
} from "./rust-engine.js";

test("failed embedded extraction still tries the installed resolution chain", async () => {
  const source = `import {registerEmbeddedEngine, resolveRustEngineBinary} from ${JSON.stringify(join(import.meta.dir, "rust-engine.ts"))}; delete process.env.SWEEP_ENGINE_PATH; const expected=resolveRustEngineBinary(); registerEmbeddedEngine(()=>{throw new Error("extraction unavailable")}); if(resolveRustEngineBinary()!==expected) throw new Error("fallback changed"); process.exit(0);`;
  const proc = Bun.spawn([process.execPath, "-e", source], { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test.skipIf(process.platform === "win32")(
  "Node drains an exiting native child in order across asynchronous decoder slices",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-exit-stream-"));
    const engine = join(root, "engine");
    const harness = join(root, "harness.ts");
    const output = join(root, "harness.mjs");
    try {
      writeFileSync(
        engine,
        `#!/usr/bin/env node
const targetDir = process.argv[3];
let output = JSON.stringify({ type: "scan_started", targetDir }) + "\\n";
for (let i = 1; i <= 18000; i++) {
  output += JSON.stringify({ type: "scan_progress", scannedDirs: i, found: 0 }) + "\\n";
}
output += JSON.stringify({ type: "scan_completed", summary: {
  candidateCount: 0, estimatedTotalBytes: 0, scannedDirs: 18000, exact: false
} }) + "\\n";
process.stdout.write(output, () => process.exit(0));
`,
      );
      chmodSync(engine, 0o700);
      writeFileSync(
        harness,
        `
import { scanToPlanViaRust } from ${JSON.stringify(join(import.meta.dir, "rust-engine.ts"))};
import { DEFAULT_CONFIG } from ${JSON.stringify(join(import.meta.dir, "config.ts"))};
let count = 0;
await scanToPlanViaRust(${JSON.stringify(root)}, {
  config: DEFAULT_CONFIG,
  onProgress(progress) {
    if (progress.scannedDirs !== ++count) throw new Error("Out-of-order native progress at " + count);
  },
  waitForConsumer: () => new Promise(resolve => setTimeout(resolve, 2)),
});
if (count !== 18000) throw new Error("Native output truncated: " + count);
console.log(count);
`,
      );
      const built = await Bun.build({
        entrypoints: [harness],
        target: "node",
        outdir: root,
        naming: "harness.mjs",
      });
      expect(built.success).toBe(true);
      const child = Bun.spawn(["node", output], {
        env: { ...process.env, SWEEP_ENGINE_PATH: engine },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("18000");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(process.platform === "win32")(
  "native final output is capped by UTF-8 bytes before parsing",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-output-cap-"));
    const previous = process.env.SWEEP_ENGINE_PATH;
    const binary = join(root, "engine");
    try {
      process.env.SWEEP_ENGINE_PATH = binary;
      // 72 MiB of wire data, only 24 MiB of JS string characters.
      writeFileSync(
        binary,
        `#!/usr/bin/env node\nconst chunk = "界".repeat(8192);\n(async () => { for (let i = 0; i < 3072; i++) { if (!process.stdout.write(chunk)) await new Promise(r => process.stdout.once("drain", r)); } })();\n`,
      );
      chmodSync(binary, 0o700);
      await expect(
        scanToPlanViaRust(root, {
          config: DEFAULT_CONFIG,
          selectionPolicy: { mode: "safe", includeDangerous: false },
        }),
      ).rejects.toThrow("output exceeded 67108864 bytes");
    } finally {
      if (previous === undefined) delete process.env.SWEEP_ENGINE_PATH;
      else process.env.SWEEP_ENGINE_PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

describe("rustScanBlockedReason", () => {
  test("allows default config without streaming or exact sizing", () => {
    expect(rustScanBlockedReason(DEFAULT_CONFIG, DEFAULT_CONFIG, {})).toBeNull();
  });

  test("allows custom patterns and project config", () => {
    const withPattern = { ...DEFAULT_CONFIG, patterns: [...DEFAULT_CONFIG.patterns, "custom"] };
    expect(rustScanBlockedReason(withPattern, DEFAULT_CONFIG, {})).toBeNull();

    const project = { ...DEFAULT_CONFIG, depth: 2 };
    expect(rustScanBlockedReason(project, project, {})).toBeNull();
  });

  test("allows progressive scan callbacks", () => {
    expect(
      rustScanBlockedReason(DEFAULT_CONFIG, DEFAULT_CONFIG, {
        onEntry: () => {},
      }),
    ).toBeNull();
  });

  test("allows exact sizing", () => {
    expect(
      rustScanBlockedReason(DEFAULT_CONFIG, DEFAULT_CONFIG, {
        exact: true,
      }),
    ).toBeNull();
  });
});

test.skipIf(process.platform === "win32")(
  "native probe is bounded, keeps failure reasons, and invalidates on binary replacement",
  () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-probe-"));
    const previous = process.env.SWEEP_ENGINE_PATH;
    const binary = join(root, "engine");
    try {
      process.env.SWEEP_ENGINE_PATH = join(root, "missing-engine");
      const missing = probeRustEngine();
      expect(missing.available).toBe(false);
      expect(missing.reasonKind).toBe("spawn_error");
      expect(missing.reason).toContain("missing-engine");

      process.env.SWEEP_ENGINE_PATH = binary;
      writeFileSync(binary, "#!/bin/sh\nexit 0\n");
      chmodSync(binary, 0o700);
      expect(isRustEngineAvailable()).toBe(true);
      expect(probeRustEngine().resolvedPath).toBe(binary);

      writeFileSync(
        binary,
        "#!/bin/sh\necho \"/lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.39' not found\" >&2\nexit 127\n",
      );
      const loaderErr = probeRustEngine();
      expect(loaderErr.available).toBe(false);
      expect(loaderErr.reasonKind).toBe("probe_failed");
      expect(loaderErr.exitCode).toBe(127);
      expect(loaderErr.stderrFirstLine).toContain("GLIBC_2.39");
      expect(loaderErr.reason).toContain("127");
      expect(loaderErr.reason).toContain("GLIBC_2.39");

      writeFileSync(binary, "#!/bin/sh\nkill -TERM $$\n");
      const signaled = probeRustEngine();
      expect(signaled.available).toBe(false);
      expect(signaled.reasonKind).toBe("probe_failed");
      expect(signaled.signal).toBe("SIGTERM");
      expect(signaled.reason).toContain("SIGTERM");

      writeFileSync(binary, "#!/bin/sh\nexec sleep 30\n");
      const start = performance.now();
      const timedOut = probeRustEngine();
      expect(timedOut.available).toBe(false);
      expect(timedOut.reasonKind).toBe("timeout");
      expect(timedOut.reason).toContain("timed out");
      expect(performance.now() - start).toBeLessThan(3000);
    } finally {
      if (previous === undefined) delete process.env.SWEEP_ENGINE_PATH;
      else process.env.SWEEP_ENGINE_PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

describe("lookupExecutable & cross-platform probe semantics", () => {
  test("windowsShellFreeExtensions honors PATHEXT ordering while excluding shell scripts", () => {
    expect(windowsShellFreeExtensions(".COM;.EXE;.BAT;.CMD")).toEqual([".com", ".exe"]);
    expect(windowsShellFreeExtensions(" .CMD ; .EXE ; .BAT ")).toEqual([".exe"]);
    expect(windowsShellFreeExtensions(".BAT;.CMD")).toEqual([".exe", ".com"]);
  });

  test("Windows lookup skips .CMD shim ahead of .exe and applies PATHEXT to extensionless paths", () => {
    const files = new Set([
      "C:\\shims\\sweep-engine.cmd",
      "C:\\real\\sweep-engine.exe",
      "C:\\tools\\my-engine.exe",
    ]);
    const has = (p: string) =>
      files.has(p.toLowerCase()) || [...files].some((f) => f.toLowerCase() === p.toLowerCase());

    const fromPath = lookupExecutable("sweep-engine", {
      platform: "win32",
      pathEnv: "C:\\shims;C:\\real",
      pathextEnv: ".CMD;.BAT;.EXE",
      cwd: "C:\\work",
      isFile: has,
    });
    expect(fromPath.resolvedPath?.toLowerCase()).toBe("c:\\real\\sweep-engine.exe");

    const fromAbs = lookupExecutable("C:\\tools\\my-engine", {
      platform: "win32",
      pathEnv: "",
      pathextEnv: ".CMD;.EXE",
      cwd: "C:\\work",
      isFile: has,
    });
    expect(fromAbs.resolvedPath?.toLowerCase()).toBe("c:\\tools\\my-engine.exe");
  });

  test("configured SWEEP_ENGINE_PATH miss never reports not_installed silently (all platforms)", () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-probe-miss-"));
    const previous = process.env.SWEEP_ENGINE_PATH;
    try {
      const missingPath = join(root, "does-not-exist-engine");
      process.env.SWEEP_ENGINE_PATH = missingPath;
      const probe = probeRustEngine();
      expect(probe.available).toBe(false);
      expect(probe.reasonKind).toBe("spawn_error");
      expect(probe.reason).toContain("not found");
    } finally {
      if (previous === undefined) delete process.env.SWEEP_ENGINE_PATH;
      else process.env.SWEEP_ENGINE_PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("real executable probe resolves extensionless SWEEP_ENGINE_PATH and skips .CMD shims on Windows", () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-probe-native-"));
    const previousEngine = process.env.SWEEP_ENGINE_PATH;
    const previousPath = process.env.PATH;
    const previousPathext = process.env.PATHEXT;
    try {
      const dir1 = join(root, "first");
      const dir2 = join(root, "second");
      mkdirSync(dir1, { recursive: true });
      mkdirSync(dir2, { recursive: true });

      const ext = process.platform === "win32" ? ".exe" : "";
      const realEngine = join(dir2, `sweep-engine${ext}`);
      // Bun itself exits 0 on `--version` on every platform including Windows.
      copyFileSync(process.execPath, realEngine);
      if (process.platform !== "win32") chmodSync(realEngine, 0o755);

      if (process.platform === "win32") {
        // Put a .CMD shim ahead of the real .exe on PATH and verify it is skipped.
        writeFileSync(join(dir1, "sweep-engine.CMD"), "@echo off\r\nexit /b 1\r\n");
        process.env.PATHEXT = ".CMD;.BAT;.EXE";
        process.env.PATH = `${dir1}${delimiter}${dir2}`;
        process.env.SWEEP_ENGINE_PATH = "sweep-engine";
        const viaPath = probeRustEngine();
        expect(viaPath.available).toBe(true);
        expect(viaPath.resolvedPath?.toLowerCase()).toBe(realEngine.toLowerCase());

        // Extensionless absolute SWEEP_ENGINE_PATH must find sibling .exe via PATHEXT.
        process.env.SWEEP_ENGINE_PATH = join(dir2, "sweep-engine");
        const viaAbs = probeRustEngine();
        expect(viaAbs.available).toBe(true);
        expect(viaAbs.resolvedPath?.toLowerCase()).toBe(realEngine.toLowerCase());
      } else {
        // Put a non-executable regular file ahead of the working binary on POSIX PATH.
        const nonExec = join(dir1, "sweep-engine");
        writeFileSync(nonExec, "#!/bin/sh\nexit 0\n");
        chmodSync(nonExec, 0o644);
        process.env.PATH = `${dir1}${delimiter}${dir2}`;
        process.env.SWEEP_ENGINE_PATH = "sweep-engine";
        const viaPath = probeRustEngine();
        expect(viaPath.available).toBe(true);
        expect(viaPath.resolvedPath).toBe(realEngine);

        // Preserve literal leading/trailing spaces in PATH directory names.
        const spaceDir = join(root, " padded dir ");
        mkdirSync(spaceDir);
        const spaceEngine = join(spaceDir, "sweep-engine");
        copyFileSync(process.execPath, spaceEngine);
        chmodSync(spaceEngine, 0o755);
        process.env.PATH = spaceDir;
        const viaSpace = probeRustEngine();
        expect(viaSpace.available).toBe(true);
        expect(viaSpace.resolvedPath).toBe(spaceEngine);

        // Empty, whitespace-only, ".", and relative POSIX PATH segments must never resolve cwd.
        const relativeBin = join(dir2, "relbin");
        mkdirSync(relativeBin);
        const relativeEngine = join(relativeBin, "sweep-engine");
        copyFileSync(process.execPath, relativeEngine);
        chmodSync(relativeEngine, 0o755);

        const singleSpaceDir = join(dir2, " ");
        mkdirSync(singleSpaceDir);
        const singleSpaceEngine = join(singleSpaceDir, "sweep-engine");
        copyFileSync(process.execPath, singleSpaceEngine);
        chmodSync(singleSpaceEngine, 0o755);

        for (const pathEnv of [
          "",
          ":/nonexistent",
          "/nonexistent:",
          "/nonexistent::/also-missing",
          " ",
          "\t",
          ".",
          ".:/nonexistent",
          "relbin",
          "./relbin",
          "../second",
        ]) {
          const miss = lookupExecutable("sweep-engine", {
            platform: "linux",
            pathEnv,
            cwd: dir2,
          });
          expect(miss.resolvedPath).toBeUndefined();
          expect(miss.nonExecutablePath).toBeUndefined();
        }

        // An absolute entry after empty/relative entries is still found.
        const afterSkipped = lookupExecutable("sweep-engine", {
          platform: "linux",
          pathEnv: `:.:relbin:${dir2}`,
          cwd: dir2,
        });
        expect(afterSkipped.resolvedPath).toBe(realEngine);
      }
    } finally {
      if (previousEngine === undefined) delete process.env.SWEEP_ENGINE_PATH;
      else process.env.SWEEP_ENGINE_PATH = previousEngine;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousPathext === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = previousPathext;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows lookup skips empty, whitespace-only, '.', and relative PATH segments", () => {
    const files = new Set([
      "C:\\work\\sweep-engine.exe",
      "C:\\work\\relbin\\sweep-engine.exe",
      "C:\\work\\ \\sweep-engine.exe",
      "C:\\bin\\sweep-engine.exe",
      "C:\\real\\sweep-engine.exe",
      "\\\\server\\share\\bin\\sweep-engine.exe",
    ]);
    const has = (p: string) =>
      files.has(p.toLowerCase()) || [...files].some((f) => f.toLowerCase() === p.toLowerCase());

    for (const pathEnv of [
      "",
      ";C:\\nonexistent",
      "C:\\nonexistent;",
      "C:\\nonexistent;;C:\\missing",
      " ",
      '" "',
      ".",
      '".;"',
      ".;C:\\nonexistent",
      "relbin",
      ".\\relbin",
      "..\\work",
      "C:relbin",
      "\\bin",
      "/bin",
    ]) {
      const miss = lookupExecutable("sweep-engine", {
        platform: "win32",
        pathEnv,
        pathextEnv: ".COM;.EXE",
        cwd: "C:\\work",
        isFile: has,
      });
      expect(miss.resolvedPath).toBeUndefined();
    }

    const fromAbs = lookupExecutable("sweep-engine", {
      platform: "win32",
      pathEnv: ";.;relbin;C:\\real",
      pathextEnv: ".COM;.EXE",
      cwd: "C:\\work",
      isFile: has,
    });
    expect(fromAbs.resolvedPath?.toLowerCase()).toBe("c:\\real\\sweep-engine.exe");

    const fromUnc = lookupExecutable("sweep-engine", {
      platform: "win32",
      pathEnv: ";.;\\\\server\\share\\bin",
      pathextEnv: ".COM;.EXE",
      cwd: "C:\\work",
      isFile: has,
    });
    expect(fromUnc.resolvedPath?.toLowerCase()).toBe("\\\\server\\share\\bin\\sweep-engine.exe");
  });

  test("engine spawn paths never execute a planted sweep-engine in cwd via empty or relative PATH", async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-no-cwd-spawn-"));
    const relDir = join(root, "relbin");
    mkdirSync(relDir, { recursive: true });
    const marker = join(root, "executed.marker");
    const ext = process.platform === "win32" ? ".exe" : "";
    const cwdPlanted = join(root, `sweep-engine${ext}`);
    const relPlanted = join(relDir, `sweep-engine${ext}`);
    const previousCwd = process.cwd();
    const previousEngine = process.env.SWEEP_ENGINE_PATH;
    const previousPath = process.env.PATH;

    try {
      if (process.platform === "win32") {
        copyFileSync(process.execPath, cwdPlanted);
        copyFileSync(process.execPath, relPlanted);
      } else {
        const script = `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\nexit 0\n`;
        writeFileSync(cwdPlanted, script);
        writeFileSync(relPlanted, script);
        chmodSync(cwdPlanted, 0o755);
        chmodSync(relPlanted, 0o755);
      }

      const emptyPlan: ScanPlan = {
        protocolVersion: "1",
        targetDir: root,
        createdAt: new Date(1000).toISOString(),
        selectionPolicy: { mode: "default", includeDangerous: false },
        candidates: [],
        selectedCandidateIds: [],
        summary: {
          candidateCount: 0,
          estimatedTotalBytes: 0,
          scannedDirs: 1,
          exact: false,
          selectedCount: 0,
          riskCounts: { safe: 0, caution: 0, dangerous: 0, blocked: 0 },
        },
      };

      const badPaths =
        process.platform === "win32"
          ? [
              "",
              ";C:\\nonexistent-sweep-dir",
              "C:\\nonexistent-sweep-dir;",
              "C:\\nonexistent-sweep-dir;;C:\\also-missing",
              " ",
              ".",
              ".\\relbin",
              "relbin",
            ]
          : [
              "",
              ":/nonexistent-sweep-dir",
              "/nonexistent-sweep-dir:",
              "/nonexistent-sweep-dir::/also-missing",
              " ",
              ".",
              "./relbin",
              "relbin",
            ];

      process.chdir(root);
      process.env.SWEEP_ENGINE_PATH = "sweep-engine";

      for (const pathEnv of badPaths) {
        process.env.PATH = pathEnv;

        const probe = probeRustEngine();
        expect(probe.available).toBe(false);
        expect(probe.resolvedPath).toBeUndefined();

        expect(gitTrackedPathsViaEngine([join(root, "node_modules")])).toBeNull();

        await expect(
          scanToPlanViaRust(root, {
            config: DEFAULT_CONFIG,
            selectionPolicy: { mode: "default", includeDangerous: false },
          }),
        ).rejects.toThrow(/rust engine/i);

        await expect(applyPlanViaRust(emptyPlan)).rejects.toBeInstanceOf(ApplyRefusedError);

        await expect(DiscoveryIndexSession.open(emptyPlan)).rejects.toBeInstanceOf(
          DiscoveryIndexError,
        );

        expect(existsSync(marker)).toBe(false);
      }
    } finally {
      process.chdir(previousCwd);
      if (previousEngine === undefined) delete process.env.SWEEP_ENGINE_PATH;
      else process.env.SWEEP_ENGINE_PATH = previousEngine;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unconfigured probe outside workspace reports not_installed with a full sentence and ignores cwd binary", async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-unconfigured-probe-"));
    const harness = join(root, "harness.ts");
    const output = join(root, "harness.mjs");
    const ext = process.platform === "win32" ? ".exe" : "";
    const planted = join(root, `sweep-engine${ext}`);
    const marker = join(root, "executed.marker");

    try {
      if (process.platform === "win32") {
        copyFileSync(process.execPath, planted);
      } else {
        writeFileSync(planted, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\nexit 0\n`);
        chmodSync(planted, 0o755);
      }

      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(
        harness,
        `
import { probeRustEngine } from ${JSON.stringify(join(import.meta.dir, "rust-engine.ts"))};
delete process.env.SWEEP_ENGINE_PATH;
const result = probeRustEngine();
console.log(JSON.stringify(result));
`,
      );
      const built = await Bun.build({
        entrypoints: [harness],
        target: "bun",
        outdir: root,
        naming: "harness.mjs",
      });
      expect(built.success).toBe(true);

      const badPaths =
        process.platform === "win32"
          ? [
              "",
              ";C:\\nonexistent-sweep-dir",
              "C:\\nonexistent-sweep-dir;",
              "C:\\nonexistent-sweep-dir;;C:\\also-missing",
              ".",
              ".\\relbin",
              "relbin",
            ]
          : [
              "",
              ":/nonexistent-sweep-dir",
              "/nonexistent-sweep-dir:",
              "/a::/b",
              ".",
              "./relbin",
              "relbin",
            ];

      const baseEnv: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k.toUpperCase() === "PATH" || k === "SWEEP_ENGINE_PATH") continue;
        baseEnv[k] = v;
      }

      for (const pathEnv of badPaths) {
        const proc = Bun.spawn([process.execPath, "--no-install", output], {
          cwd: root,
          env: {
            ...baseEnv,
            PATH: pathEnv,
            NODE_PATH: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        const result = JSON.parse(stdout) as {
          available: boolean;
          reasonKind?: string;
          reason?: string;
        };
        expect(result.available).toBe(false);
        expect(result.reasonKind).toBe("not_installed");
        expect(result.reason).toBe("Native Rust engine binary was not found.");
        expect(existsSync(marker)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
