import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDocLinks } from "../../scripts/check-doc-links.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("check-doc-links scope", () => {
  test("ignores untracked scratch/cache Markdown and still catches broken links in tracked docs", () => {
    const repo = mkdtempSync(join(tmpdir(), "sweep-doc-links-test-"));
    roots.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });

    writeFileSync(join(repo, "target.md"), "# Target\n");
    writeFileSync(join(repo, "README.md"), "[ok](target.md)\n");
    execFileSync("git", ["add", "target.md", "README.md"], { cwd: repo });

    // Local untracked cache / scratch tree containing broken Markdown links.
    const cacheDir = join(repo, ".local-audit-cache", "third-party");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "README.md"), "[broken](does-not-exist.md)\n");

    const clean = checkDocLinks(repo);
    expect(clean.broken).toEqual([]);
    expect(clean.publicErrors).toEqual([]);

    // Now break a tracked doc and verify the gate catches it.
    writeFileSync(join(repo, "README.md"), "[missing](missing.md)\n");
    const broken = checkDocLinks(repo);
    expect(broken.broken).toHaveLength(1);
    expect(broken.broken[0]?.url).toBe("missing.md");
  });
});
