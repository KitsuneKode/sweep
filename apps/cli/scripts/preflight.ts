/**
 * Publish guardrails for @kitsunekode/sweep (apps/cli).
 * Run via: `bun run preflight` (turbo → apps/cli).
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NATIVE_PLATFORM_NPM_NAMES } from "@kitsunekode/sweep-core/native-platforms";
import {
  collectManifestEntryTargets,
  findReactDevMarkers,
  readPackedTarball,
  verifyDistAgainstManifest,
} from "./bundle-contract.js";
import { assertPublishable, preparePublishManifest, readCatalogs } from "./prepack.js";
import { releasePolicy } from "./release-policy.js";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(CLI_ROOT, "../..");
const DIST = join(CLI_ROOT, "dist/sweep.js");
const PKG_PATH = join(CLI_ROOT, "package.json");
const ALLOWED_DIST_FILES = new Set(["sweep.js", "sweep-ui.js", "sweep-lib.js"]);

const NODE = process.env.npm_node_execpath ?? Bun.which("node") ?? "node";
const RETRYABLE_RM_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const activeChildren = new Set<Bun.Subprocess>();

function terminateProcessTree(proc: Bun.Subprocess): void {
  if (process.platform === "win32" && typeof proc.pid === "number") {
    try {
      Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/t", "/f"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      // Fall back to direct kill below if taskkill is unavailable.
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // Child process already exited.
  }
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class CommandError extends Error {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(message: string, result: CommandResult) {
    super(message);
    this.name = "CommandError";
    this.status = result.timedOut ? null : result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.timedOut = result.timedOut;
  }
}

async function drainProcessStreams(
  stdoutPromise: Promise<string>,
  stderrPromise: Promise<string>,
  maxMs: number,
): Promise<[string, string]> {
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all([stdoutPromise, stderrPromise]),
      new Promise<[string, string]>((resolveTimeout) => {
        drainTimer = setTimeout(() => resolveTimeout(["", ""]), maxMs);
      }),
    ]);
  } finally {
    if (drainTimer !== undefined) clearTimeout(drainTimer);
  }
}

/**
 * Spawn a child process and always await its exit (killing and awaiting on
 * timeout or failure) before returning, so callers never race a running child.
 */
export async function runCommand(
  cmd: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  activeChildren.add(proc);

  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(proc);
    }, options.timeoutMs);
  }

  try {
    const exitCode = await proc.exited;
    const [stdout, stderr] = await drainProcessStreams(
      stdoutPromise,
      stderrPromise,
      timedOut ? 1_000 : 5_000,
    );
    return { exitCode, stdout, stderr, timedOut };
  } catch (err) {
    if (proc.exitCode === null) {
      terminateProcessTree(proc);
      await proc.exited.catch(() => {});
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    activeChildren.delete(proc);
  }
}

async function execCommand(
  cmd: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const result = await runCommand(cmd, options);
  if (result.timedOut) {
    throw new CommandError(
      `command timed out after ${options.timeoutMs}ms: ${cmd.join(" ")}`,
      result,
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new CommandError(
      detail
        ? `command failed (exit ${result.exitCode}): ${cmd.join(" ")}\n${detail}`
        : `command failed (exit ${result.exitCode}): ${cmd.join(" ")}`,
      result,
    );
  }
  return result.stdout;
}

export async function removeTempDir(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 10 || !code || !RETRYABLE_RM_CODES.has(code)) throw err;
      await Bun.sleep(200);
    }
  }
}

let failed = false;
let signalExitCode: number | null = null;
const activePackDirs = new Set<string>();

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  if (signalExitCode !== null) return;
  try {
    await fn();
    if (signalExitCode !== null) return;
    console.log(`  ✓  ${label}`);
  } catch (err) {
    if (signalExitCode !== null) return;
    const base = err instanceof Error ? err.message : String(err);
    const stderr =
      err && typeof err === "object" && "stderr" in err && typeof err.stderr === "string"
        ? err.stderr.trim()
        : "";
    const msg = stderr && !base.includes(stderr) ? `${base}\n     ${stderr}` : base;
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

interface ExtractedTarball {
  packDir: string;
  packageDir: string;
  distDir: string;
  entries: Set<string>;
  manifest: Record<string, unknown>;
}

let extractedTarball: ExtractedTarball | null = null;

function linkNodeModules(source: string, destination: string): void {
  if (!existsSync(source) || existsSync(destination)) return;
  symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
}

export function parseNpmPackJson(stdout: string): string[] {
  let parsed: unknown;
  let found = false;
  for (const match of stdout.matchAll(/^[ \t]*[[{]/gm)) {
    const index = match.index;
    if (index === undefined) continue;
    try {
      parsed = JSON.parse(stdout.slice(index));
      found = true;
      break;
    } catch {
      // Lifecycle output may precede the JSON payload.
    }
  }
  if (!found) {
    throw new Error(`npm pack --json produced no parseable JSON: ${stdout.slice(0, 400)}`);
  }
  const entries: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object"
      ? "filename" in parsed
        ? [parsed]
        : Object.values(parsed)
      : [];
  const filenames: string[] = [];
  for (const entry of entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !("filename" in entry) ||
      typeof entry.filename !== "string" ||
      entry.filename.length === 0
    ) {
      throw new Error(`npm pack --json entry missing filename: ${stdout.slice(0, 400)}`);
    }
    filenames.push(entry.filename);
  }
  return filenames;
}

function stageCliForPack(packDir: string): string {
  const stageRepo = join(packDir, "stage");
  const stageCli = join(stageRepo, "apps", "cli");
  mkdirSync(stageCli, { recursive: true });
  for (const rootFile of ["package.json", "README.md", "LICENSE"] as const) {
    const src = join(REPO_ROOT, rootFile);
    if (existsSync(src)) copyFileSync(src, join(stageRepo, rootFile));
  }
  linkNodeModules(join(REPO_ROOT, "node_modules"), join(stageRepo, "node_modules"));
  for (const entry of readdirSync(CLI_ROOT)) {
    if (entry === "node_modules" || entry === "package.json.prepack-backup") continue;
    cpSync(join(CLI_ROOT, entry), join(stageCli, entry), { recursive: true });
  }
  linkNodeModules(join(CLI_ROOT, "node_modules"), join(stageCli, "node_modules"));
  return stageCli;
}

async function packAndExtractTarball(): Promise<ExtractedTarball> {
  const packDir = mkdtempSync(join(tmpdir(), "sweep-preflight-pack-"));
  activePackDirs.add(packDir);
  try {
    // Pack from an isolated staging copy so an interrupted or timed-out `npm pack`
    // can never leave the checkout's `apps/cli/package.json` rewritten.
    const stageCli = stageCliForPack(packDir);
    const out = await execCommand(["npm", "pack", "--json", "--pack-destination", packDir], {
      cwd: stageCli,
      timeoutMs: 60_000,
    });
    const packedFiles = parseNpmPackJson(out);
    assert(
      packedFiles.length === 1,
      `npm pack did not produce a single tarball: ${out.slice(0, 400)}`,
    );
    const tgzPath = join(packDir, packedFiles[0]!);
    const packageDir = join(packDir, "package");
    const { entries, manifest } = readPackedTarball(tgzPath, packageDir);
    assert(manifest !== null, "packed tarball is missing package/package.json");
    // Mirror the workspace node_modules hierarchy so runtime probes and module
    // resolution against extracted files find declared external dependencies
    // (e.g. @opentui/core) without executing workspace dist/ files.
    linkNodeModules(join(CLI_ROOT, "node_modules"), join(packageDir, "node_modules"));
    linkNodeModules(join(REPO_ROOT, "node_modules"), join(packDir, "node_modules"));
    return {
      packDir,
      packageDir,
      distDir: join(packageDir, "dist"),
      entries,
      manifest,
    };
  } catch (err) {
    activePackDirs.delete(packDir);
    await removeTempDir(packDir);
    throw err;
  }
}

function requirePackedFile(relPath: string): string {
  assert(
    extractedTarball !== null,
    `packed tarball is unavailable; cannot verify packed ${relPath}`,
  );
  const fullPath = join(extractedTarball!.packageDir, relPath);
  assert(existsSync(fullPath), `packed tarball is missing ${relPath}. Run: bun run build`);
  return fullPath;
}

async function main(): Promise<void> {
  console.log("\npreflight checks\n");

  const onSignal = (signal: NodeJS.Signals) => {
    signalExitCode = signal === "SIGINT" ? 130 : 143;
    for (const proc of activeChildren) terminateProcessTree(proc);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await check("dist/sweep.js, dist/sweep-ui.js, and dist/sweep-lib.js all exist", () => {
      for (const file of ALLOWED_DIST_FILES) {
        assert(
          existsSync(join(CLI_ROOT, "dist", file)),
          `missing dist/${file}. Run: bun run build`,
        );
      }
    });

    await check("dist/sweep.js starts with shebang on line 1", () => {
      if (!existsSync(DIST)) return;
      const first = readFileSync(DIST, "utf8").slice(0, 22);
      assert(first.startsWith("#!/usr/bin/env node"), `got: ${JSON.stringify(first)}`);
    });

    await check("dist/sweep.js bundle size > 10 KB", () => {
      if (!existsSync(DIST)) return;
      const { size } = statSync(DIST);
      assert(size > 10_000, `suspiciously small: ${size} bytes; build may have failed silently`);
    });

    await check("dist/ contains only expected bundle files", () => {
      if (!existsSync(join(CLI_ROOT, "dist"))) return;
      const files = readdirSync(join(CLI_ROOT, "dist"));
      const unexpected = files.filter((f) => !ALLOWED_DIST_FILES.has(f));
      assert(unexpected.length === 0, `unexpected files in dist/: ${unexpected.join(", ")}`);
    });

    await check("publish bundles stay within the 4 MiB distribution budget", () => {
      const bytes = [...ALLOWED_DIST_FILES].reduce((total, file) => {
        const path = join(CLI_ROOT, "dist", file);
        return total + (existsSync(path) ? statSync(path).size : 0);
      }, 0);
      assert(
        bytes <= 4 * 1024 * 1024,
        `${bytes} bundle bytes exceed 4 MiB; review dependency/asset growth`,
      );
    });

    await check("packed manifest strips devDependencies/scripts and resolves all ranges", () => {
      const packed = preparePublishManifest(pkg(), readCatalogs(REPO_ROOT));
      assert(!("devDependencies" in packed), "packed manifest must not include devDependencies");
      assert(!("scripts" in packed), "packed manifest must not include monorepo scripts");
    });

    await check(
      "packed tarball contains every exports/bin entry point and valid runtime imports",
      async () => {
        const distDir = join(CLI_ROOT, "dist");
        assert(existsSync(distDir), "dist/ not found. Run: bun run build");
        extractedTarball = await packAndExtractTarball();
        const { entries, manifest, distDir: packedDistDir } = extractedTarball;

        assert(
          !("devDependencies" in manifest),
          "packed tarball manifest must not include devDependencies",
        );
        assert(!("scripts" in manifest), "packed tarball manifest must not include scripts");
        assertPublishable(manifest);

        const entryTargets = collectManifestEntryTargets(manifest);
        assert(entryTargets.length > 0, "packed manifest has no exports/bin targets");
        for (const target of entryTargets) {
          assert(
            entries.has(target),
            `packed tarball is missing advertised entry point "${target}"`,
          );
        }

        assert(existsSync(packedDistDir), "packed tarball is missing dist/");
        const { errors } = verifyDistAgainstManifest({
          distDir: packedDistDir,
          packedManifest: manifest,
          tarballEntries: entries,
          nodeBin: NODE,
        });
        assert(errors.length === 0, errors.join("\n     "));
      },
    );

    await check("dist/sweep-ui.js contains no React development markers", () => {
      const uiBundle = requirePackedFile("dist/sweep-ui.js");
      const markers = findReactDevMarkers(readFileSync(uiBundle, "utf8"));
      assert(
        markers.length === 0,
        `dist/sweep-ui.js contains React development markers: ${markers.join(", ")}`,
      );
    });

    await check("sweep --version prints a version string", async () => {
      const packedBin = requirePackedFile("dist/sweep.js");
      const out = await execCommand([NODE, packedBin, "--version"], { timeoutMs: 15_000 });
      assert(out.trim().length > 0, "version output was empty");
      assert(/\d+\.\d+\.\d+/.test(out), `version output doesn't look like semver: ${out.trim()}`);
    });

    await check("sweep --help exits 0", async () => {
      const packedBin = requirePackedFile("dist/sweep.js");
      await execCommand([NODE, packedBin, "--help"], { timeoutMs: 15_000 });
    });

    await check("sweep rejects /tmp with exit code 2 (path-too-shallow guardrail)", async () => {
      const packedBin = requirePackedFile("dist/sweep.js");
      const res = await runCommand([NODE, packedBin, "--dry-run", "--yes", "/tmp"], {
        timeoutMs: 15_000,
      });
      assert(!res.timedOut, "process timed out waiting for exit code 2");
      assert(res.exitCode !== 0, "expected exit code 2 but process exited 0");
      assert(res.exitCode === 2, `expected exit code 2, got ${String(res.exitCode)}`);
    });

    await check("sweep rejects / with exit code 2 (blocked root guardrail)", async () => {
      const packedBin = requirePackedFile("dist/sweep.js");
      const res = await runCommand([NODE, packedBin, "--dry-run", "--yes", "/"], {
        timeoutMs: 15_000,
      });
      assert(!res.timedOut, "process timed out waiting for exit code 2");
      assert(res.exitCode !== 0, "expected exit code 2 but process exited 0");
      assert(res.exitCode === 2, `expected exit code 2, got ${String(res.exitCode)}`);
    });

    await check("package.json has all required publish fields", () => {
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

    await check("package name is @kitsunekode/sweep", () => {
      const { name } = pkg() as { name: string };
      assert(name === "@kitsunekode/sweep", `got: "${name}"`);
    });

    await check("version is valid release semver (including prereleases)", () => {
      const { version } = pkg() as { version: string };
      releasePolicy(version);
    });

    await check("publishConfig.access is 'public' (required for scoped packages)", () => {
      const { publishConfig } = pkg() as { publishConfig?: { access?: string } };
      assert(publishConfig?.access === "public", `got: ${JSON.stringify(publishConfig?.access)}`);
    });

    await check("bin points to dist/sweep.js", () => {
      const { bin } = pkg() as { bin?: Record<string, string> };
      assert(bin?.["sweep"] === "dist/sweep.js", `got: ${JSON.stringify(bin)}`);
    });

    await check("every workspace and packed exports/bin target resolves to a real file", () => {
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

    await check("sweep-lib.js imports without running the CLI", async () => {
      // The programmatic surface must not parse argv on import - importing the
      // packed bundle and exiting clean proves the bin bootstrap isn't in it.
      const lib = requirePackedFile("dist/sweep-lib.js");
      await execCommand(
        [
          NODE,
          "-e",
          `import(${JSON.stringify(pathToFileURL(lib).href)}).then(m => { if (typeof m.makeProgram !== "function") process.exit(2); })`,
        ],
        { timeoutMs: 15_000 },
      );
    });

    await check("sweep-ui.js loads under Bun runtime", async () => {
      const ui = requirePackedFile("dist/sweep-ui.js");
      await execCommand(
        [
          process.execPath,
          "-e",
          `import(${JSON.stringify(pathToFileURL(ui).href)}).then(m => { if (typeof m.runSweepUiStreaming !== "function") process.exit(2); })`,
        ],
        { timeoutMs: 15_000 },
      );
    });

    await check("files array includes dist, README.md, and LICENSE", () => {
      const { files } = pkg() as { files?: string[] };
      assert(Array.isArray(files), `got: ${JSON.stringify(files)}`);
      for (const entry of ["dist", "README.md", "LICENSE"]) {
        assert(files.includes(entry), `missing files entry: "${entry}"`);
      }
    });

    await check("optionalDependencies include all native engine packages", () => {
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

    await check("native-packages templates exist for each platform", () => {
      for (const name of NATIVE_PLATFORM_NPM_NAMES) {
        const id = name.replace("@kitsunekode/sweep-engine-", "");
        const templatePath = join(REPO_ROOT, "native-packages", id, "package.json");
        assert(existsSync(templatePath), `missing template: ${templatePath}`);
      }
    });

    await check("peerDependencies use literal semver (not catalog:)", () => {
      const { peerDependencies } = pkg() as { peerDependencies?: Record<string, string> };
      if (!peerDependencies) return;
      for (const [name, version] of Object.entries(peerDependencies)) {
        assert(
          version !== "catalog:",
          `${name} peerDependency must not use catalog: (got catalog:)`,
        );
      }
    });

    await check(".env is not tracked by git", async () => {
      const res = await runCommand(
        ["git", "-C", REPO_ROOT, "ls-files", "--error-unmatch", ".env"],
        { timeoutMs: 10_000 },
      );
      assert(!res.timedOut, "git ls-files timed out");
      assert(res.exitCode !== 0, ".env IS tracked by git. Run: git rm --cached .env");
      assert(res.exitCode === 1, `unexpected git exit code ${String(res.exitCode)}`);
    });

    await check("no uncommitted changes to apps/ or packages/", async () => {
      const out = await execCommand(
        ["git", "-C", REPO_ROOT, "status", "--porcelain", "apps/", "packages/"],
        { timeoutMs: 10_000 },
      );
      assert(out.trim() === "", `uncommitted changes in apps/ or packages/:\n${out}`);
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    const children = [...activeChildren];
    for (const proc of children) terminateProcessTree(proc);
    await Promise.allSettled(children.map((proc) => proc.exited));
    const tar = extractedTarball as ExtractedTarball | null;
    if (tar) activePackDirs.add(tar.packDir);
    for (const dir of activePackDirs) {
      activePackDirs.delete(dir);
      await removeTempDir(dir).catch(() => {});
    }
  }

  if (signalExitCode !== null) {
    process.exit(signalExitCode);
  }

  console.log();
  if (failed) {
    console.error("preflight failed. Fix the errors above before publishing\n");
    process.exit(1);
  }

  console.log("all checks passed. Ready to publish\n");
}

if (import.meta.main) {
  await main();
}
