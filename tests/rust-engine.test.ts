import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  isRustEngineAvailable,
  resolveRustEngineBinary,
  scanToPlanViaRust,
} from "@kitsunekode/sweep-core/rust-engine";

const REPO_ROOT = resolve(import.meta.dir, "..");
const FIXTURE = join(REPO_ROOT, "tests/fixtures/node_modules-only");
const LOCAL_BINARY = join(REPO_ROOT, "target/debug/sweep-engine");

describe("rust engine subprocess", () => {
  test("resolveRustEngineBinary prefers local debug build when present", () => {
    if (!existsSync(LOCAL_BINARY)) {
      expect(resolveRustEngineBinary()).toBe("sweep-engine");
      return;
    }

    expect(resolveRustEngineBinary()).toBe(LOCAL_BINARY);
  });

  test("scanToPlanViaRust matches node_modules-only fixture shape", () => {
    if (!existsSync(LOCAL_BINARY)) {
      return;
    }

    expect(isRustEngineAvailable()).toBe(true);

    const plan = scanToPlanViaRust(FIXTURE);
    expect(plan.protocolVersion).toBe("1");
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.name).toBe("node_modules");
    expect(plan.candidates[0]?.id).toBe("cand_1884c9f3");
  });
});
