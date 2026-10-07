import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "./config.js";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRustEngineAvailable, rustScanBlockedReason, scanToPlanViaRust } from "./rust-engine.js";

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
  "native probe is bounded and invalidates on binary replacement",
  () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-probe-"));
    const previous = process.env.SWEEP_ENGINE_PATH;
    const binary = join(root, "engine");
    try {
      process.env.SWEEP_ENGINE_PATH = binary;
      writeFileSync(binary, "#!/bin/sh\nexit 0\n");
      chmodSync(binary, 0o700);
      expect(isRustEngineAvailable()).toBe(true);
      writeFileSync(binary, "#!/bin/sh\nexit 3\n");
      expect(isRustEngineAvailable()).toBe(false);
      writeFileSync(binary, "#!/bin/sh\nexec sleep 30\n");
      const start = performance.now();
      expect(isRustEngineAvailable()).toBe(false);
      expect(performance.now() - start).toBeLessThan(3000);
    } finally {
      if (previous === undefined) delete process.env.SWEEP_ENGINE_PATH;
      else process.env.SWEEP_ENGINE_PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
