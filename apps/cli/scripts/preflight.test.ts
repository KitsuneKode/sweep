import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTempDir, runCommand } from "./preflight.js";

const PREFLIGHT_TEST_TIMEOUT_MS = 30_000;
const PREFLIGHT_CHILD_TIMEOUT_MS = 25_000;

test(
  "actual preflight accepts preview versions and rejects malformed versions",
  async () => {
    // Execute the real script against owned manifests. Other checks deliberately
    // fail because this is not a complete release tree; no publication runs.
    const parent = join(import.meta.dir, "../../../target");
    mkdirSync(parent, { recursive: true });
    const owned = mkdtempSync(join(parent, "preflight-version-"));
    const cli = join(owned, "apps/cli");
    mkdirSync(join(cli, "scripts"), { recursive: true });
    for (const script of [
      "preflight.ts",
      "release-policy.ts",
      "bundle-contract.ts",
      "prepack.ts",
      "atomic-write.ts",
    ])
      copyFileSync(join(import.meta.dir, script), join(cli, "scripts", script));
    writeFileSync(join(owned, "package.json"), JSON.stringify({ workspaces: { catalog: {} } }));
    try {
      for (const [version, valid] of [
        ["0.4.0-next.0", true],
        ["0.4.0", true],
        ["0.4.0-next.01", false],
        ["01.4.0", false],
      ] as const) {
        writeFileSync(
          join(cli, "package.json"),
          JSON.stringify({ name: "@kitsunekode/sweep", version }),
        );
        const {
          stdout: out,
          stderr: err,
          exitCode: code,
          timedOut,
        } = await runCommand([process.execPath, join(cli, "scripts/preflight.ts")], {
          timeoutMs: PREFLIGHT_CHILD_TIMEOUT_MS,
        });
        expect(timedOut).toBe(false);
        expect(code).not.toBe(0); // Missing dist must still refuse publication.
        expect(valid ? out : err).toContain(
          `${valid ? "✓" : "✗"}  version is valid release semver`,
        );
        if (!valid) expect(err).toContain("Invalid release version");
      }
    } finally {
      await removeTempDir(owned);
    }
  },
  PREFLIGHT_TEST_TIMEOUT_MS,
);

test(
  "actual preflight fails when dist/sweep-lib.js is missing even if src/ and dist/sweep.js exist",
  async () => {
    const parent = join(import.meta.dir, "../../../target");
    mkdirSync(parent, { recursive: true });
    const owned = mkdtempSync(join(parent, "preflight-missing-lib-"));
    const cli = join(owned, "apps/cli");
    mkdirSync(join(cli, "scripts"), { recursive: true });
    mkdirSync(join(cli, "src"), { recursive: true });
    mkdirSync(join(cli, "dist"), { recursive: true });
    for (const script of [
      "preflight.ts",
      "release-policy.ts",
      "bundle-contract.ts",
      "prepack.ts",
      "postpack.ts",
      "atomic-write.ts",
    ]) {
      copyFileSync(join(import.meta.dir, script), join(cli, "scripts", script));
    }
    writeFileSync(join(owned, "package.json"), JSON.stringify({ workspaces: { catalog: {} } }));
    writeFileSync(join(owned, "README.md"), "# readme\n");
    writeFileSync(join(owned, "LICENSE"), "MIT\n");
    writeFileSync(join(cli, "src/index.ts"), "export {};\n");
    writeFileSync(join(cli, "src/bin.ts"), "export {};\n");
    writeFileSync(
      join(cli, "dist/sweep.js"),
      `#!/usr/bin/env node\n${"//".repeat(6000)}\nconsole.log("0.5.3");\n`,
    );
    writeFileSync(join(cli, "dist/sweep-ui.js"), "export const ui = 1;\n");
    // Deliberately omit dist/sweep-lib.js.
    writeFileSync(
      join(cli, "package.json"),
      JSON.stringify({
        name: "@kitsunekode/sweep",
        version: "0.5.3",
        description: "test",
        license: "MIT",
        bin: { sweep: "dist/sweep.js" },
        files: ["dist", "README.md", "LICENSE"],
        exports: { ".": "./src/index.ts", "./bin": "./src/bin.ts" },
        publishConfig: { access: "public" },
        repository: "https://example.com/repo",
        homepage: "https://example.com",
        bugs: "https://example.com/issues",
        scripts: {
          prepack: "bun run ./scripts/prepack.ts",
          postpack: "bun run ./scripts/postpack.ts",
        },
      }),
    );

    try {
      const {
        stderr: err,
        exitCode: code,
        timedOut,
      } = await runCommand([process.execPath, join(cli, "scripts/preflight.ts")], {
        timeoutMs: PREFLIGHT_CHILD_TIMEOUT_MS,
      });
      expect(timedOut).toBe(false);
      expect(code).not.toBe(0);
      expect(err).toContain("dist/sweep-lib.js");
      expect(err).toContain(
        "every workspace and packed exports/bin target resolves to a real file",
      );
      expect(err).toContain("packed tarball contains every exports/bin entry point");
      expect(err).toContain("sweep-lib.js imports without running the CLI");
    } finally {
      await removeTempDir(owned);
    }
  },
  PREFLIGHT_TEST_TIMEOUT_MS,
);

test(
  "actual preflight fails when packed dist/sweep-lib.js throws on import even if workspace dist/sweep-lib.js is valid",
  async () => {
    const parent = join(import.meta.dir, "../../../target");
    mkdirSync(parent, { recursive: true });
    const owned = mkdtempSync(join(parent, "preflight-throwing-packed-lib-"));
    const cli = join(owned, "apps/cli");
    mkdirSync(join(cli, "scripts"), { recursive: true });
    mkdirSync(join(cli, "src"), { recursive: true });
    mkdirSync(join(cli, "dist"), { recursive: true });
    for (const script of [
      "preflight.ts",
      "release-policy.ts",
      "bundle-contract.ts",
      "prepack.ts",
      "postpack.ts",
      "atomic-write.ts",
    ]) {
      copyFileSync(join(import.meta.dir, script), join(cli, "scripts", script));
    }
    writeFileSync(join(owned, "package.json"), JSON.stringify({ catalog: {} }));
    writeFileSync(join(owned, "README.md"), "# readme\n");
    writeFileSync(join(owned, "LICENSE"), "MIT\n");
    writeFileSync(join(cli, "src/index.ts"), "export {};\n");
    writeFileSync(join(cli, "src/bin.ts"), "export {};\n");
    writeFileSync(
      join(cli, "dist/sweep.js"),
      `#!/usr/bin/env node\n${"//".repeat(6000)}\nif (process.argv.includes("--version")) console.log("0.5.3");\nelse if (process.argv.includes("/tmp") || process.argv.includes("/")) process.exit(2);\n`,
    );
    writeFileSync(join(cli, "dist/sweep-lib.js"), "export function makeProgram() { return {}; }\n");
    writeFileSync(
      join(cli, "dist/sweep-ui.js"),
      "export function runSweepUiStreaming() { return {}; }\n",
    );
    // Simulate a tarball whose packed dist/sweep-lib.js throws on import while
    // the workspace dist/sweep-lib.js remains completely valid.
    writeFileSync(
      join(cli, "scripts/tamper-pack.ts"),
      [
        'import { copyFileSync, writeFileSync } from "node:fs";',
        'import { dirname, join, resolve } from "node:path";',
        'import { fileURLToPath } from "node:url";',
        'const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");',
        'copyFileSync(join(cliRoot, "dist/sweep-lib.js"), join(cliRoot, "sweep-lib.backup.js"));',
        'writeFileSync(join(cliRoot, "dist/sweep-lib.js"), \'throw new Error("packed sweep-lib boom");\\n\');',
      ].join("\n"),
    );
    writeFileSync(
      join(cli, "scripts/restore-pack.ts"),
      [
        'import { copyFileSync, existsSync, rmSync } from "node:fs";',
        'import { dirname, join, resolve } from "node:path";',
        'import { fileURLToPath } from "node:url";',
        'const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");',
        'const backup = join(cliRoot, "sweep-lib.backup.js");',
        'if (existsSync(backup)) { copyFileSync(backup, join(cliRoot, "dist/sweep-lib.js")); rmSync(backup); }',
      ].join("\n"),
    );
    writeFileSync(
      join(cli, "package.json"),
      JSON.stringify({
        name: "@kitsunekode/sweep",
        version: "0.5.3",
        type: "module",
        description: "test",
        license: "MIT",
        bin: { sweep: "dist/sweep.js" },
        files: ["dist", "README.md", "LICENSE"],
        exports: { ".": "./src/index.ts", "./bin": "./src/bin.ts" },
        publishConfig: { access: "public" },
        repository: "https://example.com/repo",
        homepage: "https://example.com",
        bugs: "https://example.com/issues",
        scripts: {
          prepack: "bun run ./scripts/prepack.ts && bun run ./scripts/tamper-pack.ts",
          postpack: "bun run ./scripts/postpack.ts && bun run ./scripts/restore-pack.ts",
        },
      }),
    );

    try {
      const {
        stderr: err,
        exitCode: code,
        timedOut,
      } = await runCommand([process.execPath, join(cli, "scripts/preflight.ts")], {
        timeoutMs: PREFLIGHT_CHILD_TIMEOUT_MS,
      });
      expect(timedOut).toBe(false);
      expect(code).not.toBe(0);
      expect(err).toContain("sweep-lib.js imports without running the CLI");
      expect(err).toContain("packed sweep-lib boom");
    } finally {
      await removeTempDir(owned);
    }
  },
  PREFLIGHT_TEST_TIMEOUT_MS,
);

test(
  "runCommand kills and awaits a timed-out child before returning so its cwd can be removed",
  async () => {
    const parent = join(import.meta.dir, "../../../target");
    mkdirSync(parent, { recursive: true });
    const owned = mkdtempSync(join(parent, "preflight-timeout-child-"));
    try {
      const result = await runCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        cwd: owned,
        timeoutMs: 200,
      });
      expect(result.timedOut).toBe(true);
      rmSync(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      expect(existsSync(owned)).toBe(false);
    } finally {
      await removeTempDir(owned);
    }
  },
  PREFLIGHT_TEST_TIMEOUT_MS,
);
