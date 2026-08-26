#!/usr/bin/env node
/**
 * Launcher for the globally-installed `sweep` command.
 *
 * Resolution order:
 *   1. Standalone native binary from the platform package
 *      (@kitsunekode/sweep-<platform>, an optionalDependency) — fastest path,
 *      no Node runtime needed for the TUI's native FFI.
 *   2. Bundled JS entry (dist/sweep.js) — always present; requires Node >= 18.
 *
 * Mirrors esbuild/opentui-style platform package resolution. Never fails hard
 * when the platform package is absent or mismatched: falls back to JS.
 */
"use strict";

const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

const PLATFORMS = [
  ["darwin", "arm64", "sweep-darwin-arm64", "sweep"],
  ["darwin", "x64", "sweep-darwin-x64", "sweep"],
  ["linux", "arm64", "sweep-linux-arm64", "sweep"],
  ["linux", "x64", "sweep-linux-x64", "sweep"],
  ["win32", "x64", "sweep-win-x64", "sweep.exe"],
];

function platformBinary() {
  const match = PLATFORMS.find(([os, cpu]) => os === process.platform && cpu === process.arch);
  if (!match) return null;
  const [, , pkgName, binName] = match;
  try {
    const pkgDir = path.dirname(
      require.resolve(`${pkgName}/package.json`, { paths: [__dirname, process.cwd()] }),
    );
    const binary = path.join(pkgDir, "bin", binName);
    return existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

function runJs() {
  const jsEntry = path.join(__dirname, "..", "dist", "sweep.js");
  if (!existsSync(jsEntry)) {
    console.error("sweep: neither native binary nor dist/sweep.js found — reinstall the package.");
    process.exit(4);
  }
  const child = spawn(process.execPath, [jsEntry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  child.on("close", (code) => process.exit(code ?? 1));
}

const native = platformBinary();
if (native) {
  const child = spawn(native, process.argv.slice(2), { stdio: "inherit" });
  child.on("error", () => runJs()); // e.g. exec-format on odd setups → JS fallback
  child.on("close", (code) => process.exit(code ?? 1));
} else {
  runJs();
}
