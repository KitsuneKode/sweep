/**
 * Publish guardrails for @kitsunekode/sweep (apps/cli).
 * Run via: `bun run preflight` (turbo → apps/cli).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_PLATFORM_NPM_NAMES } from "@kitsunekode/sweep-core/native-platforms";
import {
  collectManifestEntryTargets,
  findReactDevMarkers,
  readPackedTarball,
  verifyDistAgainstManifest,
} from "./bundle-contract.js";
import { preparePublishManifest, readCatalogs } from "./prepack.js";
import { releasePolicy } from "./release-policy.js";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(CLI_ROOT, "../..");
const DIST = join(CLI_ROOT, "dist/sweep.js");
const PKG_PATH = join(CLI_ROOT, "package.json");
const ALLOWED_DIST_FILES = new Set(["sweep.js", "sweep-ui.js", "sweep-lib.js"]);

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
  return JSON.parse(readFileSync(PKG_PATH, "utf8")) as Record<string, unknown>;
}

console.log("\npreflight checks\n");

check("dist/sweep.js, dist/sweep-ui.js, and dist/sweep-lib.js all exist", () => {
  for (const file of ALLOWED_DIST_FILES) {
    assert(existsSync(join(CLI_ROOT, "dist", file)), `missing dist/${file}. Run: bun run build`);
  }
});

check("dist/sweep.js starts with shebang on line 1", () => {
  if (!existsSync(DIST)) return;
  const first = readFileSync(DIST, "utf8").slice(0, 22);
  assert(first.startsWith("#!/usr/bin/env node"), `got: ${JSON.stringify(first)}`);
});

check("dist/sweep.js bundle size > 10 KB", () => {
  if (!existsSync(DIST)) return;
  const { size } = statSync(DIST);
  assert(size > 10_000, `suspiciously small: ${size} bytes; build may have failed silently`);
});

check("dist/ contains only expected bundle files", () => {
  if (!existsSync(join(CLI_ROOT, "dist"))) return;
  const files = readdirSync(join(CLI_ROOT, "dist"));
  const unexpected = files.filter((f) => !ALLOWED_DIST_FILES.has(f));
  assert(unexpected.length === 0, `unexpected files in dist/: ${unexpected.join(", ")}`);
});

check("publish bundles stay within the 4 MiB distribution budget", () => {
  const bytes = [...ALLOWED_DIST_FILES].reduce((total, file) => {
    const path = join(CLI_ROOT, "dist", file);
    return total + (existsSync(path) ? statSync(path).size : 0);
  }, 0);
  assert(
    bytes <= 4 * 1024 * 1024,
    `${bytes} bundle bytes exceed 4 MiB; review dependency/asset growth`,
  );
});

check("dist/sweep-ui.js contains no React development markers", () => {
  const uiBundle = join(CLI_ROOT, "dist/sweep-ui.js");
  assert(existsSync(uiBundle), "not found. Run: bun run build");
  const markers = findReactDevMarkers(readFileSync(uiBundle, "utf8"));
  assert(
    markers.length === 0,
    `dist/sweep-ui.js contains React development markers: ${markers.join(", ")}`,
  );
});

check("packed manifest strips devDependencies/scripts and resolves all ranges", () => {
  const packed = preparePublishManifest(pkg(), readCatalogs(REPO_ROOT));
  assert(!("devDependencies" in packed), "packed manifest must not include devDependencies");
  assert(!("scripts" in packed), "packed manifest must not include monorepo scripts");
});

check("packed tarball contains every exports/bin entry point and valid runtime imports", () => {
  const distDir = join(CLI_ROOT, "dist");
  assert(existsSync(distDir), "dist/ not found. Run: bun run build");
  const packDir = mkdtempSync(join(tmpdir(), "sweep-preflight-pack-"));
  try {
    const out = execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], {
      cwd: CLI_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const jsonStart = out.search(/^\s*\[/m);
    const packedList = JSON.parse(jsonStart >= 0 ? out.slice(jsonStart) : out) as Array<{
      filename: string;
    }>;
    assert(
      packedList.length === 1 && typeof packedList[0]?.filename === "string",
      `npm pack did not produce a single tarball: ${out.slice(0, 400)}`,
    );
    const tgzPath = join(packDir, packedList[0]!.filename);
    const { entries, manifest } = readPackedTarball(tgzPath);
    assert(manifest !== null, "packed tarball is missing package/package.json");

    const entryTargets = collectManifestEntryTargets(manifest);
    assert(entryTargets.length > 0, "packed manifest has no exports/bin targets");
    for (const target of entryTargets) {
      assert(entries.has(target), `packed tarball is missing advertised entry point "${target}"`);
    }

    const { errors } = verifyDistAgainstManifest({
      distDir,
      packedManifest: manifest,
      tarballEntries: entries,
      nodeBin: NODE,
    });
    assert(errors.length === 0, errors.join("\n     "));
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
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

check("package name is @kitsunekode/sweep", () => {
  const { name } = pkg() as { name: string };
  assert(name === "@kitsunekode/sweep", `got: "${name}"`);
});

check("version is valid release semver (including prereleases)", () => {
  const { version } = pkg() as { version: string };
  releasePolicy(version);
});

check("publishConfig.access is 'public' (required for scoped packages)", () => {
  const { publishConfig } = pkg() as { publishConfig?: { access?: string } };
  assert(publishConfig?.access === "public", `got: ${JSON.stringify(publishConfig?.access)}`);
});

check("bin points to dist/sweep.js", () => {
  const { bin } = pkg() as { bin?: Record<string, string> };
  assert(bin?.["sweep"] === "dist/sweep.js", `got: ${JSON.stringify(bin)}`);
});

check("every workspace and packed exports/bin target resolves to a real file", () => {
  const workspaceTargets = collectManifestEntryTargets(pkg());
  assert(workspaceTargets.length > 0, "workspace manifest has no exports/bin targets");
  for (const target of workspaceTargets) {
    assert(existsSync(join(CLI_ROOT, target)), `missing workspace target: ${target}`);
  }
  const packedTargets = collectManifestEntryTargets(
    preparePublishManifest(pkg(), readCatalogs(REPO_ROOT)),
  );
  assert(packedTargets.length > 0, "packed manifest has no exports/bin targets");
  for (const target of packedTargets) {
    assert(existsSync(join(CLI_ROOT, target)), `missing packed target: ${target}`);
  }
});

check("sweep-lib.js imports without running the CLI", () => {
  // The programmatic surface must not parse argv on import - importing the
  // package and exiting clean proves the bin bootstrap isn't in this bundle.
  const lib = join(CLI_ROOT, "dist/sweep-lib.js");
  assert(existsSync(lib), "dist/sweep-lib.js is missing. Run: bun run build");
  const out = execFileSync(
    NODE,
    [
      "-e",
      `import("${lib.replaceAll("\\", "/")}").then(m => { if (typeof m.makeProgram !== "function") process.exit(2); })`,
    ],
    { encoding: "utf8", timeout: 5000, stdio: "pipe" },
  );
  void out;
});

check("files array includes dist, README.md, and LICENSE", () => {
  const { files } = pkg() as { files?: string[] };
  assert(Array.isArray(files), `got: ${JSON.stringify(files)}`);
  for (const entry of ["dist", "README.md", "LICENSE"]) {
    assert(files.includes(entry), `missing files entry: "${entry}"`);
  }
});

check("optionalDependencies include all native engine packages", () => {
  const { optionalDependencies, version } = pkg() as {
    optionalDependencies?: Record<string, string>;
    version: string;
  };
  assert(optionalDependencies, "missing optionalDependencies");
  for (const name of NATIVE_PLATFORM_NPM_NAMES) {
    assert(name in optionalDependencies, `missing optionalDependency: ${name}`);
    assert(
      optionalDependencies[name] === version,
      `${name} version ${optionalDependencies[name]} !== package ${version}`,
    );
  }
});

check("native-packages templates exist for each platform", () => {
  for (const name of NATIVE_PLATFORM_NPM_NAMES) {
    const id = name.replace("@kitsunekode/sweep-engine-", "");
    const templatePath = join(REPO_ROOT, "native-packages", id, "package.json");
    assert(existsSync(templatePath), `missing template: ${templatePath}`);
  }
});

check("peerDependencies use literal semver (not catalog:)", () => {
  const { peerDependencies } = pkg() as { peerDependencies?: Record<string, string> };
  if (!peerDependencies) return;
  for (const [name, version] of Object.entries(peerDependencies)) {
    assert(version !== "catalog:", `${name} peerDependency must not use catalog: (got catalog:)`);
  }
});

check(".env is not tracked by git", () => {
  try {
    execFileSync("git", ["-C", REPO_ROOT, "ls-files", "--error-unmatch", ".env"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    throw new Error(".env IS tracked by git. Run: git rm --cached .env");
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
  console.error("preflight failed. Fix the errors above before publishing\n");
  process.exit(1);
}

console.log("all checks passed. Ready to publish\n");
