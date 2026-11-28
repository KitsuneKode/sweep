#!/usr/bin/env bun
/**
 * Prepare npm so CI can publish over OIDC (trusted publishing).
 *
 * Two things must be true for every package the release publishes:
 *
 *   1. The package exists on the registry. npm only exposes the trusted
 *      publisher setting on a package that has already been published, so a
 *      brand-new platform package cannot be bootstrapped by CI. The first
 *      publish has to come from an authenticated human.
 *   2. A trusted publisher is registered for it, pointing at this repo and
 *      workflow with publish permission enabled.
 *
 * This script does both. It is idempotent: packages already on npm are not
 * republished, and packages that already carry a matching GitHub trusted
 * publisher (with publish allowed) are skipped before `npm trust github` so
 * the owner is not prompted for 2FA once per already-configured package.
 *
 * Every npm write here prompts for 2FA, so it has to be run by a human:
 *
 *   bun run bootstrap:npm-trust                      # report only
 *   bun run bootstrap:npm-trust -- --publish --trust # do it
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_PLATFORMS, type NativePlatform } from "@kitsunekode/sweep-core/native-platforms";

export const CLI_PACKAGE = "@kitsunekode/sweep";
export const REPO = "KitsuneKode/sweep";
export const WORKFLOW = "release.yml";

/**
 * Deliberately below any shipping version. The CLI pins its engines to an exact
 * version, so a placeholder must never occupy one a real release wants.
 */
export const PLACEHOLDER_VERSION = "0.0.1";

export interface NpmCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type NpmRunner = (args: string[], options?: { interactive?: boolean }) => NpmCommandResult;

export interface BootstrapFailure {
  name: string;
  step: "publish" | "trust";
  reason: string;
}

export interface BootstrapResult {
  exitCode: number;
  dryRun: boolean;
  published: string[];
  trusted: string[];
  alreadyTrusted: string[];
  failed: BootstrapFailure[];
}

export interface BootstrapOptions {
  publishMissing?: boolean;
  configureTrust?: boolean;
  platforms?: readonly NativePlatform[];
  runNpm?: NpmRunner;
  log?: (message: string) => void;
  error?: (message: string) => void;
  stagingRoot?: string;
}

export function defaultNpmRunner(
  args: string[],
  options?: { interactive?: boolean },
): NpmCommandResult {
  const interactive = options?.interactive === true;
  const result = spawnSync("npm", args, {
    stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse `npm trust list <name> --json` output.
 *
 * npm 11.20 prints empty stdout when there are no trust configs, a single JSON
 * object for one config, and multiple blank-line-separated JSON objects when
 * more than one config exists. Also accepts a JSON array for forward
 * compatibility. Returns `null` if stdout cannot be parsed.
 */
export function parseTrustListOutput(stdout: string): Record<string, unknown>[] | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      if (parsed.every(isRecord)) {
        return parsed;
      }
      return null;
    }
    if (isRecord(parsed)) {
      return [parsed];
    }
    return null;
  } catch {
    // Fall through to parse concatenated JSON objects emitted by npm 11.20.
  }

  const entries: Record<string, unknown>[] = [];
  let i = 0;
  while (i < trimmed.length) {
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) {
      i += 1;
    }
    if (i >= trimmed.length) {
      break;
    }
    if (trimmed[i] !== "{") {
      return null;
    }
    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (; i < trimmed.length; i += 1) {
      const ch = trimmed[i]!;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          i = end;
          break;
        }
      }
    }
    if (end === -1) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(start, end));
      if (!isRecord(parsed)) {
        return null;
      }
      entries.push(parsed);
    } catch {
      return null;
    }
  }

  return entries;
}

function allowsPublish(entry: Record<string, unknown>): boolean {
  if (Array.isArray(entry.permissions)) {
    return entry.permissions.some((perm) => perm === "createPackage" || perm === "publish");
  }
  if (typeof entry.allowPublish === "boolean") {
    return entry.allowPublish;
  }
  // Legacy npm CLI / registry responses pre-dating the permissions field
  // only supported full publish.
  return entry.permissions === undefined;
}

export function hasMatchingGitHubTrust(
  entries: readonly Record<string, unknown>[],
  repo: string = REPO,
  workflow: string = WORKFLOW,
): boolean {
  const normalizedRepo = repo.toLowerCase();
  return entries.some((entry) => {
    if (typeof entry.type !== "string" || entry.type.toLowerCase() !== "github") {
      return false;
    }
    const claims = isRecord(entry.claims) ? entry.claims : undefined;
    const workflowRef = claims && isRecord(claims.workflow_ref) ? claims.workflow_ref : undefined;

    const entryRepo =
      typeof entry.repository === "string"
        ? entry.repository
        : typeof claims?.repository === "string"
          ? claims.repository
          : null;
    const entryFile =
      typeof entry.file === "string"
        ? entry.file
        : typeof workflowRef?.file === "string"
          ? workflowRef.file
          : null;
    const entryEnv =
      typeof entry.environment === "string"
        ? entry.environment
        : typeof claims?.environment === "string"
          ? claims.environment
          : null;

    if (!entryRepo || entryRepo.toLowerCase() !== normalizedRepo) {
      return false;
    }
    if (entryFile !== workflow) {
      return false;
    }
    if (entryEnv && entryEnv.trim().length > 0) {
      return false;
    }
    return allowsPublish(entry);
  });
}

export function checkAlreadyTrusted(
  name: string,
  runNpm: NpmRunner,
  repo: string = REPO,
  workflow: string = WORKFLOW,
): "trusted" | "not_trusted" | "unknown" {
  const result = runNpm(["trust", "list", name, "--json"], { interactive: false });
  if (result.status !== 0) {
    return "unknown";
  }
  const entries = parseTrustListOutput(result.stdout);
  if (entries === null) {
    return "unknown";
  }
  return hasMatchingGitHubTrust(entries, repo, workflow) ? "trusted" : "not_trusted";
}

/** Latest published version, or null when the package does not exist. */
function publishedVersion(name: string, runNpm: NpmRunner): string | null {
  const result = runNpm(["view", name, "version"], { interactive: false });
  if (result.status !== 0) {
    return null;
  }
  const version = result.stdout.trim();
  return version.length > 0 ? version : null;
}

function writePlaceholder(dir: string, name: string, os: string, cpu: string, libc?: string): void {
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = {
    name,
    version: PLACEHOLDER_VERSION,
    description: `Placeholder for the sweep-engine binary for ${os} ${cpu}${libc === "musl" ? " (musl)" : ""}. Reserves the package so npm trusted publishing can be configured; real builds are published by CI.`,
    license: "MIT",
    repository: { type: "git", url: `git+https://github.com/${REPO}.git` },
    os: [os],
    cpu: [cpu],
  };
  if (libc) {
    manifest.libc = [libc];
  }
  manifest.files = ["README.md"];
  manifest.publishConfig = { access: "public" };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(dir, "README.md"),
    `# ${name}

Placeholder release. This package exists so a trusted publisher (npm OIDC) can be
configured for it - npm only exposes that setting on a package that already exists.

It contains no binary. Real builds are published from CI and resolve automatically
as an optional dependency of
[${CLI_PACKAGE}](https://www.npmjs.com/package/${CLI_PACKAGE}). You do not need to
install this directly.
`,
  );
}

function formatSummaryLine(label: string, items: readonly string[]): string {
  const suffix = items.length > 0 ? ` (${items.join(", ")})` : "";
  return `  ${label.padEnd(16)} ${items.length}${suffix}`;
}

export function runBootstrap(options: BootstrapOptions = {}): BootstrapResult {
  const publishMissing = options.publishMissing ?? false;
  const configureTrust = options.configureTrust ?? false;
  const platforms = options.platforms ?? NATIVE_PLATFORMS;
  const runNpm = options.runNpm ?? defaultNpmRunner;
  const log = options.log ?? ((msg: string) => console.log(msg));
  const error = options.error ?? ((msg: string) => console.error(msg));

  const staging = mkdtempSync(join(options.stagingRoot ?? tmpdir(), "sweep-placeholders-"));
  const missing: Array<{ name: string; dir: string }> = [];
  const publishedOnNpm = new Set<string>();
  const allPackages = [CLI_PACKAGE, ...platforms.map((platform) => platform.npmName)];

  const published: string[] = [];
  const trusted: string[] = [];
  const alreadyTrusted: string[] = [];
  const failed: BootstrapFailure[] = [];

  try {
    for (const platform of platforms) {
      const existing = publishedVersion(platform.npmName, runNpm);
      if (existing) {
        publishedOnNpm.add(platform.npmName);
        log(`exists   ${platform.npmName} (${existing})`);
        continue;
      }
      log(`missing  ${platform.npmName}`);
      const dir = join(staging, platform.id);
      writePlaceholder(dir, platform.npmName, platform.os, platform.cpu, platform.libc);
      missing.push({ name: platform.npmName, dir });
    }

    const cliVersion = publishedVersion(CLI_PACKAGE, runNpm);
    if (cliVersion) {
      publishedOnNpm.add(CLI_PACKAGE);
    }
    log(
      `${cliVersion ? "exists  " : "MISSING "} ${CLI_PACKAGE}${cliVersion ? ` (${cliVersion})` : ""}`,
    );

    if (!publishMissing && !configureTrust) {
      log(
        `\nDry run. Nothing was changed.\n\n` +
          `  ${missing.length} placeholder(s) to publish\n` +
          `  ${allPackages.length} package(s) to check/point at ${REPO} / ${WORKFLOW}\n\n` +
          `Re-run with --publish --trust to apply. Writes prompt for 2FA, and\n` +
          `publishing is irreversible.`,
      );
      return {
        exitCode: 0,
        dryRun: true,
        published,
        trusted,
        alreadyTrusted,
        failed,
      };
    }

    if (publishMissing) {
      for (const entry of missing) {
        log(`\npublishing ${entry.name}@${PLACEHOLDER_VERSION}...`);
        const result = runNpm(["publish", entry.dir, "--access", "public"], { interactive: true });
        if (result.status !== 0) {
          error(`error: failed to publish ${entry.name}`);
          failed.push({
            name: entry.name,
            step: "publish",
            reason: `npm publish exited with status ${String(result.status)}`,
          });
        } else {
          published.push(entry.name);
          publishedOnNpm.add(entry.name);
        }
      }
    }

    if (configureTrust) {
      for (const name of allPackages) {
        // A package that never got published cannot carry a trusted publisher yet.
        if (!publishedOnNpm.has(name) && !publishedVersion(name, runNpm)) {
          error(`skip: ${name} is not on npm yet, so it cannot be trusted`);
          failed.push({
            name,
            step: "trust",
            reason: "package is not published on npm",
          });
          continue;
        }

        const trustState = checkAlreadyTrusted(name, runNpm);
        if (trustState === "trusted") {
          log(`already trusted  ${name} -> ${REPO} (${WORKFLOW})`);
          alreadyTrusted.push(name);
          continue;
        }
        if (trustState === "unknown") {
          log(
            `warn: could not inspect existing trust for ${name}; configuring via npm trust github`,
          );
        }

        log(`\ntrusting ${name} -> ${REPO} (${WORKFLOW})...`);
        const result = runNpm(
          ["trust", "github", name, "--file", WORKFLOW, "--repo", REPO, "--allow-publish", "--yes"],
          { interactive: true },
        );
        if (result.status !== 0) {
          error(`error: failed to configure trusted publishing for ${name}`);
          failed.push({
            name,
            step: "trust",
            reason: `npm trust github exited with status ${String(result.status)}`,
          });
        } else {
          trusted.push(name);
        }
      }
    }

    log(
      `\nSummary:\n` +
        `${formatSummaryLine("published:", published)}\n` +
        `${formatSummaryLine("trusted:", trusted)}\n` +
        `${formatSummaryLine("already trusted:", alreadyTrusted)}\n` +
        `${formatSummaryLine(
          "failed:",
          failed.map((item) => `${item.name} (${item.step})`),
        )}`,
    );

    if (failed.length > 0) {
      error(`\n${failed.length} step(s) failed.`);
      return {
        exitCode: 1,
        dryRun: false,
        published,
        trusted,
        alreadyTrusted,
        failed,
      };
    }

    log("\nnpm is ready. Re-run the Release workflow to publish over OIDC.");
    return {
      exitCode: 0,
      dryRun: false,
      published,
      trusted,
      alreadyTrusted,
      failed,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = runBootstrap({
    publishMissing: process.argv.includes("--publish"),
    configureTrust: process.argv.includes("--trust"),
  });
  process.exit(result.exitCode);
}
