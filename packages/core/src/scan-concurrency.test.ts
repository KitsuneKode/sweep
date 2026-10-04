import { expect, test } from "bun:test";
import { scanConcurrencyFor } from "./scan-concurrency.js";

test("small CPU allowances reduce simultaneous directory handles and metadata requests", () => {
  const small = scanConcurrencyFor(1);
  expect(small.traversal).toBeLessThanOrEqual(2);
  expect(small.sizingBatches).toBe(1);
  expect(small.metadata).toBeLessThanOrEqual(2);
  expect(small.traversal + small.sizingBatches * 2).toBeLessThanOrEqual(32);
  expect(scanConcurrencyFor(2).metadata).toBeLessThanOrEqual(4);
});

test("large and invalid CPU allowances never exceed the reader or I/O caps", () => {
  for (const cpus of [0, 1, 2, 3, 8, 16, 128, NaN, Infinity, -1]) {
    const limits = scanConcurrencyFor(cpus);
    expect(limits.traversal).toBeGreaterThanOrEqual(1);
    expect(limits.traversal).toBeLessThanOrEqual(16);
    expect(limits.sizingBatches).toBeGreaterThanOrEqual(1);
    expect(limits.sizingBatches).toBeLessThanOrEqual(4);
    expect(limits.metadata).toBeGreaterThanOrEqual(1);
    expect(limits.metadata).toBeLessThanOrEqual(8);
    expect(limits.traversal + limits.sizingBatches * 2).toBeLessThanOrEqual(32);
  }
  expect(scanConcurrencyFor(128)).toEqual({ traversal: 16, sizingBatches: 4, metadata: 8 });
});
