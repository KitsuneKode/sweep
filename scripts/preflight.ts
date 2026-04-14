/**
 * preflight.ts — publish guardrails
 *
 * Runs automatically via `prepublishOnly`. Blocks publish if any check fails.
 * Run manually: bun run preflight
 *
 * Checks:
 *   1. dist/sweep.js — exists, has shebang, non-trivial size
 *   2. CLI smoke tests — --version, --help, guardrail rejection of /tmp
 *   3. package.json — required fields, publishConfig, valid semver
 *   4. dist/ purity — no stray files, no .env tracked in git
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist/sweep.js");

let failed = false;

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${label}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗  ${label}`);
    console.error(`     ${msg}`);
    failed = true;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function pkg(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
}

console.log("\npreflight checks\n");

// ── 1. dist/sweep.js ─────────────────────────────────────────────────────────

check("dist/sweep.js exists", () => {
  assert(existsSync(DIST), "not found — run: bun run build");
});

check("dist/sweep.js starts with shebang on line 1", () => {
  if (!existsSync(DIST)) return;
  const first = readFileSync(DIST, "utf8").slice(0, 22);
  assert(first.startsWith("#!/usr/bin/env node"), `got: ${JSON.stringify(first)}`);
});

check("dist/sweep.js bundle size > 10 KB", () => {
  if (!existsSync(DIST)) return;
  const { size } = statSync(DIST);
  assert(size > 10_000, `suspiciously small: ${size} bytes — build may have failed silently`);
});

check("dist/ contains only sweep.js", () => {
  if (!existsSync(join(ROOT, "dist"))) return;
  const files = readdirSync(join(ROOT, "dist"));
  const unexpected = files.filter((f) => f !== "sweep.js");
  assert(unexpected.length === 0, `unexpected files in dist/: ${unexpected.join(", ")}`);
});

// ── 2. CLI smoke tests ────────────────────────────────────────────────────────

check("sweep --version prints a version string", () => {
  if (!existsSync(DIST)) return;
  const out = execFileSync(process.execPath, [DIST, "--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert(out.trim().length > 0, "version output was empty");
  assert(/\d+\.\d+\.\d+/.test(out), `version output doesn't look like semver: ${out.trim()}`);
});

check("sweep --help exits 0", () => {
  if (!existsSync(DIST)) return;
  execFileSync(process.execPath, [DIST, "--help"], {
    encoding: "utf8",
    timeout: 5000,
  });
});

check("sweep rejects /tmp with exit code 2 (path-too-shallow guardrail)", () => {
  if (!existsSync(DIST)) return;
  try {
    execFileSync(process.execPath, [DIST, "--dry-run", "--yes", "/tmp"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: "pipe",
    });
    throw new Error("expected exit code 2 but process exited 0");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { status?: number };
    // re-throw if it's our sentinel "exited 0" error
    if (e.message?.includes("exited 0")) throw e;
    assert(e.status === 2, `expected exit code 2, got ${String(e.status)}`);
  }
});

check("sweep rejects / with exit code 2 (blocked root guardrail)", () => {
  if (!existsSync(DIST)) return;
  try {
    execFileSync(process.execPath, [DIST, "--dry-run", "--yes", "/"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: "pipe",
    });
    throw new Error("expected exit code 2 but process exited 0");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { status?: number };
    if (e.message?.includes("exited 0")) throw e;
    assert(e.status === 2, `expected exit code 2, got ${String(e.status)}`);
  }
});

// ── 3. package.json sanity ────────────────────────────────────────────────────

check("package.json has all required publish fields", () => {
  const p = pkg();
  const required = [
    "name",
    "version",
    "description",
    "license",
    "bin",
    "files",
    "repository",
    "homepage",
    "bugs",
  ];
  for (const field of required) {
    assert(field in p, `missing field: "${field}"`);
  }
});

check("version is valid semver (x.y.z)", () => {
  const { version } = pkg() as { version: string };
  assert(/^\d+\.\d+\.\d+$/.test(version), `invalid: "${version}"`);
});

check("publishConfig.access is 'public' (required for scoped packages)", () => {
  const { publishConfig } = pkg() as { publishConfig?: { access?: string } };
  assert(publishConfig?.access === "public", `got: ${JSON.stringify(publishConfig?.access)}`);
});

check("bin points to dist/sweep.js", () => {
  const { bin } = pkg() as { bin?: Record<string, string> };
  assert(bin?.["sweep"] === "./dist/sweep.js", `got: ${JSON.stringify(bin)}`);
});

check("files array includes 'dist'", () => {
  const { files } = pkg() as { files?: string[] };
  assert(Array.isArray(files) && files.includes("dist"), `got: ${JSON.stringify(files)}`);
});

// ── 4. hygiene ────────────────────────────────────────────────────────────────

check(".env is not tracked by git", () => {
  try {
    execFileSync("git", ["-C", ROOT, "ls-files", "--error-unmatch", ".env"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    throw new Error(".env IS tracked by git — run: git rm --cached .env");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { status?: number };
    if (e.message?.includes("IS tracked")) throw e;
    // exit code 1 = not tracked — that's what we want
    assert(e.status === 1, `unexpected git exit code ${String(e.status)}`);
  }
});

check("no uncommitted changes to src/", () => {
  const out = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "src/"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert(out.trim() === "", `uncommitted changes in src/:\n${out}`);
});

// ── Result ────────────────────────────────────────────────────────────────────

console.log();
if (failed) {
  console.error("preflight failed — fix the errors above before publishing\n");
  process.exit(1);
} else {
  console.log("all checks passed — ready to publish\n");
  console.log("  next steps:");
  console.log("    npm version patch   # or minor / major");
  console.log("    git push --follow-tags");
  console.log("    npm publish\n");
}
