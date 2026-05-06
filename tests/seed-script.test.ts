import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, rmSync } from "node:fs";
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

  test("creates a mixed-risk scenario with a symlink and custom artifact", () => {
    const proc = Bun.spawnSync({
      cmd: [
        Bun.which("bun") ?? "bun",
        "run",
        "scripts/seed-fixture.ts",
        "--",
        "--scenario",
        "risk-mix",
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

    expect(report.scenario).toBe("risk-mix");
    expect(existsSync(join(report.root, "node_modules"))).toBe(true);
    expect(existsSync(join(report.root, "custom-cache"))).toBe(true);
    expect(lstatSync(join(report.root, "linked-dist")).isSymbolicLink()).toBe(true);
  });

  test("creates a workspace-matrix scenario with multiple project artifact types", () => {
    const proc = Bun.spawnSync({
      cmd: [
        Bun.which("bun") ?? "bun",
        "run",
        "scripts/seed-fixture.ts",
        "--",
        "--scenario",
        "workspace-matrix",
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

    expect(report.scenario).toBe("workspace-matrix");
    expect(existsSync(join(report.root, "packages", "web", "node_modules"))).toBe(true);
    expect(existsSync(join(report.root, "packages", "api", "target"))).toBe(true);
    expect(existsSync(join(report.root, "apps", "docs", ".next"))).toBe(true);
    expect(existsSync(join(report.root, "apps", "docs", "custom-cache"))).toBe(true);
  });
});
