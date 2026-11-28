#!/usr/bin/env bun
/**
 * Render Homebrew formula and Scoop bucket manifests from checked-in templates
 * and verified release checksum sidecars in dist-bin/.
 *
 * Usage:
 *   bun run apps/cli/scripts/render-packaging.ts homebrew --version 0.5.3 --dist-dir dist-bin --template packaging/homebrew/sweep.rb.tmpl --out Formula/sweep.rb [--reject-downgrade]
 *   bun run apps/cli/scripts/render-packaging.ts scoop --version 0.5.3 --dist-dir dist-bin --template packaging/scoop/sweep.json --out bucket/sweep.json [--reject-downgrade]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface HomebrewChecksums {
  darwinArm64Gz: string;
  darwinX64Gz: string;
  linuxArm64Gz: string;
  linuxX64Gz: string;
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function assertStableOrReleaseVersion(version: string): string {
  const clean = version.trim();
  if (!SEMVER_RE.test(clean)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return clean;
}

/** Compare two semver strings (`-1` if a < b, `0` if equal, `1` if a > b). */
export function compareSemver(a: string, b: string): number {
  const ma = SEMVER_RE.exec(a.trim());
  const mb = SEMVER_RE.exec(b.trim());
  if (!ma) throw new Error(`Invalid semver: ${a}`);
  if (!mb) throw new Error(`Invalid semver: ${b}`);

  for (let i = 1; i <= 3; i++) {
    const na = Number.parseInt(ma[i]!, 10);
    const nb = Number.parseInt(mb[i]!, 10);
    if (na !== nb) return na < nb ? -1 : 1;
  }

  const preA = ma[4];
  const preB = mb[4];
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;

  const idsA = preA.split(".");
  const idsB = preB.split(".");
  const len = Math.max(idsA.length, idsB.length);
  for (let i = 0; i < len; i++) {
    const ia = idsA[i];
    const ib = idsB[i];
    if (ia === ib) continue;
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const numA = /^\d+$/.test(ia);
    const numB = /^\d+$/.test(ib);
    if (numA && numB) {
      const diff = Number.parseInt(ia, 10) - Number.parseInt(ib, 10);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (numA !== numB) {
      return numA ? -1 : 1;
    } else {
      return ia < ib ? -1 : 1;
    }
  }
  return 0;
}

export function extractHomebrewFormulaVersion(formulaSource: string): string | null {
  const match = /^\s*version\s+"([^"]+)"\s*$/m.exec(formulaSource);
  return match?.[1]?.trim() ?? null;
}

export function extractScoopManifestVersion(manifestJson: string): string | null {
  try {
    const parsed = JSON.parse(manifestJson) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

export function assertNotDowngrade(
  targetVersion: string,
  existingVersion: string | null,
  label: string,
): void {
  if (!existingVersion) return;
  if (compareSemver(targetVersion, existingVersion) < 0) {
    throw new Error(`Refusing to downgrade ${label} from ${existingVersion} to ${targetVersion}`);
  }
}

export function parseSha256File(content: string, label: string): string {
  const firstToken = content.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!SHA256_RE.test(firstToken)) {
    throw new Error(`Invalid SHA-256 digest in ${label}: ${JSON.stringify(firstToken)}`);
  }
  return firstToken;
}

export function renderHomebrewFormula(
  template: string,
  version: string,
  checksums: HomebrewChecksums,
): string {
  const cleanVersion = assertStableOrReleaseVersion(version);
  const replacements: Record<string, string> = {
    "{{VERSION}}": cleanVersion,
    "{{SHA256_DARWIN_ARM64_GZ}}": parseSha256File(checksums.darwinArm64Gz, "darwin-arm64.gz"),
    "{{SHA256_DARWIN_X64_GZ}}": parseSha256File(checksums.darwinX64Gz, "darwin-x64.gz"),
    "{{SHA256_LINUX_ARM64_GZ}}": parseSha256File(checksums.linuxArm64Gz, "linux-arm64.gz"),
    "{{SHA256_LINUX_X64_GZ}}": parseSha256File(checksums.linuxX64Gz, "linux-x64.gz"),
  };

  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    if (!rendered.includes(token)) {
      throw new Error(`Homebrew template is missing required placeholder ${token}`);
    }
    rendered = rendered.replaceAll(token, value);
  }

  const remaining = rendered.match(/\{\{[^}]+\}\}/g);
  if (remaining) {
    throw new Error(`Homebrew template has unresolved placeholders: ${remaining.join(", ")}`);
  }

  return rendered;
}

export function renderScoopManifest(
  templateJson: string,
  version: string,
  winX64Sha256: string,
): string {
  const cleanVersion = assertStableOrReleaseVersion(version);
  const digest = parseSha256File(winX64Sha256, "sweep-win-x64.exe");
  const manifest = JSON.parse(templateJson) as {
    version: string;
    architecture: {
      "64bit": {
        url: string;
        hash: string;
      };
    };
  };

  manifest.version = cleanVersion;
  manifest.architecture["64bit"].url =
    `https://github.com/KitsuneKode/sweep/releases/download/v${cleanVersion}/sweep-win-x64.exe#/sweep.exe`;
  manifest.architecture["64bit"].hash = digest;

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function parseCliArgs(argv: string[]): {
  mode: "homebrew" | "scoop";
  version: string;
  distDir: string;
  template: string;
  out: string;
  rejectDowngrade: boolean;
} {
  const mode = argv[0];
  if (mode !== "homebrew" && mode !== "scoop") {
    throw new Error(`Expected mode "homebrew" or "scoop", got ${JSON.stringify(mode)}`);
  }

  let version = "";
  let distDir = "";
  let template = "";
  let out = "";
  let rejectDowngrade = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version") version = argv[++i] ?? "";
    else if (arg === "--dist-dir") distDir = argv[++i] ?? "";
    else if (arg === "--template") template = argv[++i] ?? "";
    else if (arg === "--out") out = argv[++i] ?? "";
    else if (arg === "--reject-downgrade") rejectDowngrade = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!version || !distDir || !template || !out) {
    throw new Error("--version, --dist-dir, --template, and --out are all required");
  }

  return { mode, version, distDir, template, out, rejectDowngrade };
}

if (import.meta.main) {
  const { mode, version, distDir, template, out, rejectDowngrade } = parseCliArgs(
    process.argv.slice(2),
  );
  const distPath = resolve(distDir);
  const outPath = resolve(out);

  if (rejectDowngrade && existsSync(outPath)) {
    const existingRaw = readFileSync(outPath, "utf8");
    const existingVersion =
      mode === "homebrew"
        ? extractHomebrewFormulaVersion(existingRaw)
        : extractScoopManifestVersion(existingRaw);
    assertNotDowngrade(assertStableOrReleaseVersion(version), existingVersion, mode);
  }

  const templateContent = readFileSync(resolve(template), "utf8");

  let output: string;
  if (mode === "homebrew") {
    const readSum = (file: string) => readFileSync(join(distPath, file), "utf8");
    output = renderHomebrewFormula(templateContent, version, {
      darwinArm64Gz: readSum("sweep-darwin-arm64.gz.sha256"),
      darwinX64Gz: readSum("sweep-darwin-x64.gz.sha256"),
      linuxArm64Gz: readSum("sweep-linux-arm64.gz.sha256"),
      linuxX64Gz: readSum("sweep-linux-x64.gz.sha256"),
    });
  } else {
    const winSum = readFileSync(join(distPath, "sweep-win-x64.exe.sha256"), "utf8");
    output = renderScoopManifest(templateContent, version, winSum);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output);
  console.log(`rendered ${mode} manifest for ${version} -> ${outPath}`);
}
