import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryEntries, disposeDirectoryReader } from "./directory-reader.js";
import { ResourceBudget } from "./resource-budget.js";

let owned: string;
beforeEach(() => {
  owned = mkdtempSync(join(tmpdir(), "sweep-dir-reader-test-"));
  for (let i = 0; i < 65; i++) writeFileSync(join(owned, String(i)), "");
});
afterEach(() => rmSync(owned, { recursive: true, force: true }));

test("aborting a live reader rejects further batches and closes the worker", async () => {
  const budget = new ResourceBudget();
  const controller = new AbortController();
  const entries = directoryEntries(owned, budget, controller.signal);
  try {
    expect((await entries.next()).done).toBe(false);
    controller.abort();
    // Cancellation must also reject while consuming an already received batch.
    let caught: unknown;
    try {
      for await (const _entry of entries) {
        /* drain the admitted batch */
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("AbortError");
  } finally {
    disposeDirectoryReader(budget);
  }
});

test("closing an enumeration early allows another enumeration", async () => {
  const budget = new ResourceBudget();
  try {
    for await (const _entry of directoryEntries(owned, budget)) break;
    let count = 0;
    for await (const _entry of directoryEntries(owned, budget)) count++;
    expect(count).toBe(65);
  } finally {
    disposeDirectoryReader(budget);
  }
});

test("Bun reports a missing Node reader as an explicit incomplete scan", async () => {
  const module = join(import.meta.dir, "scanner.ts");
  const config = join(import.meta.dir, "config.ts");
  const source = `import {scan} from ${JSON.stringify(module)}; import {DEFAULT_CONFIG} from ${JSON.stringify(config)}; try { await scan(${JSON.stringify(owned)},DEFAULT_CONFIG); process.exit(9); } catch (error) { console.error(error.message); process.exit(error.exitCode ?? 2); }`;
  const proc = Bun.spawn([process.execPath, "-e", source], {
    env: { ...process.env, PATH: join(owned, "no-runtime") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(code).toBe(2);
  expect(error).toContain("install Node or use the Rust engine");
});
