import { rmSync } from "node:fs";

export type FixtureScenario =
  | "basic"
  | "monorepo"
  | "drift"
  | "risk-mix"
  | "workspace-matrix"
  | "large-plan"
  | "blocked-target";

export interface SeededFixtureReport {
  scenario: FixtureScenario;
  root: string;
  created: string[];
  guardrailTarget?: string;
}

const cleanupRoots: string[] = [];
const REPO_ROOT = new URL("../..", import.meta.url).pathname;

export function seedScenario(scenario: FixtureScenario): SeededFixtureReport {
  const proc = Bun.spawnSync({
    cmd: [
      Bun.which("bun") ?? "bun",
      "run",
      "scripts/seed-fixture.ts",
      "--",
      "--scenario",
      scenario,
    ],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      Buffer.from(proc.stderr).toString("utf8") || `fixture seed failed: ${scenario}`,
    );
  }

  const report = JSON.parse(Buffer.from(proc.stdout).toString("utf8")) as SeededFixtureReport;
  cleanupRoots.push(report.root);
  return report;
}

export function cleanupSeededFixtures(): void {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
