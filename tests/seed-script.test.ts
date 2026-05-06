import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const cleanupRoots: string[] = [];
const REPO_ROOT = new URL("..", import.meta.url).pathname;

afterEach(() => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("seed fixture script", () => {
  test("creates a monorepo scenario in tmp and reports its root", () => {
    const proc = Bun.spawnSync({
      cmd: [
        Bun.which("bun") ?? "bun",
        "run",
        "scripts/seed-fixture.ts",
        "--",
        "--scenario",
        "monorepo",
      ],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    const report = JSON.parse(Buffer.from(proc.stdout).toString("utf8")) as {
      root: string;
      created: string[];
      scenario: string;
    };

    cleanupRoots.push(report.root);

    expect(report.scenario).toBe("monorepo");
    expect(existsSync(join(report.root, "packages", "web", "node_modules"))).toBe(true);
    expect(report.created.length).toBeGreaterThan(0);
  });
});
