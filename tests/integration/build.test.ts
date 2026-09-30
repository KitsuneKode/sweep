import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIST = join(REPO_ROOT, "apps/cli/dist");
const SWEEP = join(DIST, "sweep.js");

function bunBin(): string {
  try {
    return execFileSync("command", ["-v", "bun"], { encoding: "utf8" }).trim();
  } catch {
    return "bun";
  }
}

const BUN = bunBin();

beforeAll(() => {
  if (existsSync(SWEEP)) return;
  execFileSync("bun", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
});

describe("published CLI bundle", () => {
  test("dist contains only the three public bundles", () => {
    const files = readdirSync(DIST).sort();
    expect(files).toEqual(["sweep-lib.js", "sweep-ui.js", "sweep.js"]);
  });

  test("cli and lib bundles do not import @opentui at startup", () => {
    for (const file of ["sweep.js", "sweep-lib.js"]) {
      const bundle = Bun.file(join(DIST, file));
      expect(bundle.size).toBeGreaterThan(10_000);
      const source = readFileSync(join(DIST, file), "utf8");
      expect(source.includes('from "@opentui/core"')).toBe(false);
      expect(source.includes('require("@opentui/core")')).toBe(false);
    }
  });

  test("bun apps/cli/dist/sweep.js --version exits 0 with semver output", () => {
    expect(existsSync(SWEEP)).toBe(true);
    const out = execFileSync(BUN, [SWEEP, "--version"], { encoding: "utf8" });
    expect(/\d+\.\d+\.\d+/.test(out.trim())).toBe(true);
  });

  test("node apps/cli/dist/sweep.js --version exits 0 with semver output", () => {
    expect(existsSync(SWEEP)).toBe(true);
    const node =
      process.env.npm_node_execpath ??
      (() => {
        try {
          return execFileSync("command", ["-v", "node"], { encoding: "utf8" }).trim();
        } catch {
          return "node";
        }
      })();
    const out = execFileSync(node, [SWEEP, "--version"], { encoding: "utf8" });
    expect(/\d+\.\d+\.\d+/.test(out.trim())).toBe(true);
  });

  test("bun apps/cli/dist/sweep.js --help exits 0", () => {
    execFileSync(BUN, [SWEEP, "--help"], { encoding: "utf8" });
  });
});

afterAll(() => {
  // build artifacts are shared with preflight; leave dist/ in place
});
