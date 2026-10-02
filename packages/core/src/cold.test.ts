import { afterEach, describe, expect, test } from "bun:test";
import { isColdRequested, tryDropPageCache } from "./cold.js";

const saved = process.env.SWEEP_COLD;

afterEach(() => {
  if (saved === undefined) delete process.env.SWEEP_COLD;
  else process.env.SWEEP_COLD = saved;
});

describe("isColdRequested", () => {
  test("unset means warm", () => {
    delete process.env.SWEEP_COLD;
    expect(isColdRequested()).toBe(false);
  });

  test("truthy values request cold", () => {
    for (const value of ["1", "true", "yes"]) {
      process.env.SWEEP_COLD = value;
      expect(isColdRequested()).toBe(true);
    }
  });

  test("explicit off values stay warm", () => {
    for (const value of ["", "0", "false"]) {
      process.env.SWEEP_COLD = value;
      expect(isColdRequested()).toBe(false);
    }
  });
});

describe("tryDropPageCache", () => {
  test("reports an honest outcome either way", () => {
    const report = tryDropPageCache();
    // Never throws; either it dropped (root on linux) or it explains why a
    // "cold" run is still warm - it must never claim a drop that failed.
    if (process.platform !== "linux" || process.geteuid?.() !== 0) {
      expect(report.dropped).toBe(false);
      expect(report.detail.length).toBeGreaterThan(0);
    }
  });
});
