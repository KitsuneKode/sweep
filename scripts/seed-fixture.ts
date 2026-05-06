import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Scenario = "basic" | "monorepo" | "drift" | "risk-mix" | "workspace-matrix";

function parseArgs(argv: string[]): { scenario: Scenario; root: string | undefined } {
  let scenario: Scenario = "basic";
  let root: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--scenario") {
      const value = argv[i + 1];
      if (
        value === "basic" ||
        value === "monorepo" ||
        value === "drift" ||
        value === "risk-mix" ||
        value === "workspace-matrix"
      ) {
        scenario = value;
        i++;
      }
    } else if (token === "--root") {
      root = argv[i + 1];
      i++;
    }
  }

  return { scenario, root };
}

function ensureDir(path: string, created: string[]): void {
  mkdirSync(path, { recursive: true });
  created.push(path);
}

function seedBasic(root: string, created: string[]): void {
  ensureDir(join(root, "node_modules"), created);
  ensureDir(join(root, "dist"), created);
  writeFileSync(join(root, "tsconfig.tsbuildinfo"), "");
  created.push(join(root, "tsconfig.tsbuildinfo"));
}

function seedMonorepo(root: string, created: string[]): void {
  ensureDir(join(root, "packages", "web", "node_modules"), created);
  ensureDir(join(root, "packages", "api", "dist"), created);
  ensureDir(join(root, "apps", "docs", ".next"), created);
}

function seedDrift(root: string, created: string[]): void {
  ensureDir(join(root, "node_modules"), created);
  ensureDir(join(root, "dist"), created);
}

function seedRiskMix(root: string, created: string[]): void {
  ensureDir(join(root, "node_modules"), created);
  ensureDir(join(root, "dist-target"), created);
  ensureDir(join(root, "custom-cache"), created);
  const linkedDist = join(root, "linked-dist");
  symlinkSync(join(root, "dist-target"), linkedDist);
  created.push(linkedDist);
}

function seedWorkspaceMatrix(root: string, created: string[]): void {
  ensureDir(join(root, "packages", "web", "node_modules"), created);
  ensureDir(join(root, "packages", "api", "target"), created);
  ensureDir(join(root, "apps", "docs", ".next"), created);
  ensureDir(join(root, "apps", "docs", "custom-cache"), created);
  writeFileSync(join(root, "apps", "docs", "tsconfig.tsbuildinfo"), "");
  created.push(join(root, "apps", "docs", "tsconfig.tsbuildinfo"));
}

const { scenario, root: requestedRoot } = parseArgs(process.argv.slice(2));
const root = requestedRoot ?? mkdtempSync(join(tmpdir(), `sweep-fixture-${scenario}-`));
const created: string[] = [];

switch (scenario) {
  case "basic":
    seedBasic(root, created);
    break;
  case "monorepo":
    seedMonorepo(root, created);
    break;
  case "drift":
    seedDrift(root, created);
    break;
  case "risk-mix":
    seedRiskMix(root, created);
    break;
  case "workspace-matrix":
    seedWorkspaceMatrix(root, created);
    break;
}

process.stdout.write(
  `${JSON.stringify(
    {
      scenario,
      root,
      created,
    },
    null,
    2,
  )}\n`,
);
