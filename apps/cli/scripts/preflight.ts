/**
 * Publish guardrails for the npm package at the repo root.
 * Run via: `bun run preflight` (turbo → apps/cli).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIST = join(REPO_ROOT, "dist/sweep.js");
const ALLOWED_DIST_FILES = new Set(["sweep.js", "sweep-ui.js"]);

const NODE =
  process.env.npm_node_execpath ??
  (() => {
    try {
      return execFileSync("command", ["-v", "node"], { encoding: "utf8" }).trim();
    } catch {
      return "node";
    }
  })();

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
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

console.log("\npreflight checks\n");

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

check("dist/ contains only expected bundle files", () => {
  if (!existsSync(join(REPO_ROOT, "dist"))) return;
  const files = readdirSync(join(REPO_ROOT, "dist"));
  const unexpected = files.filter((f) => !ALLOWED_DIST_FILES.has(f));
  assert(unexpected.length === 0, `unexpected files in dist/: ${unexpected.join(", ")}`);
});

check("sweep --version prints a version string", () => {
  if (!existsSync(DIST)) return;
  const out = execFileSync(NODE, [DIST, "--version"], { encoding: "utf8", timeout: 5000 });
  assert(out.trim().length > 0, "version output was empty");
  assert(/\d+\.\d+\.\d+/.test(out), `version output doesn't look like semver: ${out.trim()}`);
});

check("sweep --help exits 0", () => {
  if (!existsSync(DIST)) return;
  execFileSync(NODE, [DIST, "--help"], { encoding: "utf8", timeout: 5000 });
});

check("sweep rejects /tmp with exit code 2 (path-too-shallow guardrail)", () => {
  if (!existsSync(DIST)) return;
  try {
    execFileSync(NODE, [DIST, "--dry-run", "--yes", "/tmp"], {
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

check("sweep rejects / with exit code 2 (blocked root guardrail)", () => {
  if (!existsSync(DIST)) return;
  try {
    execFileSync(NODE, [DIST, "--dry-run", "--yes", "/"], {
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

check("package.json has all required publish fields", () => {
  const p = pkg();
  for (const field of [
    "name",
    "version",
    "description",
    "license",
    "bin",
    "files",
    "repository",
    "homepage",
    "bugs",
  ]) {
    assert(field in p, `missing field: "${field}"`);
  }
});

check("root package is not a turbo workspace member (prevents build fork bomb)", () => {
  const { workspaces } = pkg() as { workspaces?: { packages?: string[] } };
  const packages = workspaces?.packages ?? [];
  assert(
    !packages.includes("."),
    'workspaces.packages must not include "." — root scripts delegate to turbo and recurse infinitely',
  );
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
  assert(bin?.["sweep"] === "dist/sweep.js", `got: ${JSON.stringify(bin)}`);
});

check("files array includes 'dist'", () => {
  const { files } = pkg() as { files?: string[] };
  assert(Array.isArray(files) && files.includes("dist"), `got: ${JSON.stringify(files)}`);
});

check(".env is not tracked by git", () => {
  try {
    execFileSync("git", ["-C", REPO_ROOT, "ls-files", "--error-unmatch", ".env"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    throw new Error(".env IS tracked by git — run: git rm --cached .env");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { status?: number };
    if (e.message?.includes("IS tracked")) throw e;
    assert(e.status === 1, `unexpected git exit code ${String(e.status)}`);
  }
});

check("no uncommitted changes to apps/ or packages/", () => {
  const out = execFileSync(
    "git",
    ["-C", REPO_ROOT, "status", "--porcelain", "apps/", "packages/"],
    { encoding: "utf8", timeout: 5000 },
  );
  assert(out.trim() === "", `uncommitted changes in apps/ or packages/:\n${out}`);
});

console.log();
if (failed) {
  console.error("preflight failed — fix the errors above before publishing\n");
  process.exit(1);
}

console.log("all checks passed — ready to publish\n");
