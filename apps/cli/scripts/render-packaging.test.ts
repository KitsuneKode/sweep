import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNotDowngrade,
  compareSemver,
  extractHomebrewFormulaVersion,
  extractScoopManifestVersion,
  parseSha256File,
  renderHomebrewFormula,
  renderScoopManifest,
} from "./render-packaging.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("render-packaging", () => {
  test("parses GNU and Windows-star sha256 sidecar formats and rejects malformed digests", () => {
    const hex = "a".repeat(64);
    expect(parseSha256File(`${hex}  sweep-linux-x64.gz\n`, "linux")).toBe(hex);
    expect(parseSha256File(`${hex.toUpperCase()} *sweep-win-x64.exe\r\n`, "win")).toBe(hex);
    expect(() => parseSha256File("not-a-hash  file\n", "bad")).toThrow(/Invalid SHA-256/);
    expect(() => parseSha256File("", "empty")).toThrow(/Invalid SHA-256/);
  });

  test("renders Homebrew formula template with chmod 0755 before completions and validated checksums", () => {
    const template = readFileSync(join(REPO_ROOT, "packaging/homebrew/sweep.rb.tmpl"), "utf8");
    const rendered = renderHomebrewFormula(template, "0.6.0", {
      darwinArm64Gz: `${"1".repeat(64)}  sweep-darwin-arm64.gz\n`,
      darwinX64Gz: `${"2".repeat(64)}  sweep-darwin-x64.gz\n`,
      linuxArm64Gz: `${"3".repeat(64)}  sweep-linux-arm64.gz\n`,
      linuxX64Gz: `${"4".repeat(64)}  sweep-linux-x64.gz\n`,
    });

    expect(rendered).toContain('version "0.6.0"');
    expect(rendered).toContain("sweep-darwin-arm64.gz");
    expect(rendered).toContain("sweep-darwin-x64.gz");
    expect(rendered).toContain("sweep-linux-arm64.gz");
    expect(rendered).toContain("sweep-linux-x64.gz");
    expect(rendered).toContain(
      'sha256 "1111111111111111111111111111111111111111111111111111111111111111"',
    );
    const chmodIdx = rendered.indexOf('chmod 0755, bin/"sweep"');
    const compIdx = rendered.indexOf(
      'generate_completions_from_executable(bin/"sweep", "completions")',
    );
    expect(chmodIdx).toBeGreaterThan(-1);
    expect(compIdx).toBeGreaterThan(chmodIdx);
    expect(rendered).not.toContain("{{");
    expect(extractHomebrewFormulaVersion(rendered)).toBe("0.6.0");
  });

  test("renders Scoop manifest from checked-in template with checkver and autoupdate intact", () => {
    const template = readFileSync(join(REPO_ROOT, "packaging/scoop/sweep.json"), "utf8");
    const sum = "b".repeat(64);
    const rendered = renderScoopManifest(template, "0.6.0", `${sum} *sweep-win-x64.exe\n`);
    const parsed = JSON.parse(rendered) as Record<string, unknown>;

    expect(parsed.version).toBe("0.6.0");
    expect(parsed.bin).toBe("sweep.exe");
    expect(parsed.checkver).toEqual({ github: "https://github.com/KitsuneKode/sweep" });
    expect((parsed.architecture as Record<string, { url: string; hash: string }>)["64bit"]).toEqual(
      {
        url: "https://github.com/KitsuneKode/sweep/releases/download/v0.6.0/sweep-win-x64.exe#/sweep.exe",
        hash: sum,
      },
    );
    expect(extractScoopManifestVersion(rendered)).toBe("0.6.0");
  });

  test("compares semver accurately and refuses downstream downgrades", () => {
    expect(compareSemver("0.5.3", "0.5.4")).toBeLessThan(0);
    expect(compareSemver("0.5.4", "0.5.4")).toBe(0);
    expect(compareSemver("0.5.10", "0.5.4")).toBeGreaterThan(0);
    expect(compareSemver("0.5.4-next.1", "0.5.4")).toBeLessThan(0);
    expect(() => assertNotDowngrade("0.5.3", "0.5.4", "homebrew")).toThrow(/downgrade/);
    expect(() => assertNotDowngrade("0.5.4", "0.5.4", "homebrew")).not.toThrow();
    expect(() => assertNotDowngrade("0.5.5", "0.5.4", "scoop")).not.toThrow();
    expect(() => assertNotDowngrade("0.5.4", null, "scoop")).not.toThrow();
  });

  test("rejects invalid semver versions", () => {
    const template = readFileSync(join(REPO_ROOT, "packaging/scoop/sweep.json"), "utf8");
    expect(() => renderScoopManifest(template, "v0.6.0", "a".repeat(64))).toThrow(
      /Invalid release version/,
    );
  });
});
