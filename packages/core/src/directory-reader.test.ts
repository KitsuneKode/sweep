import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryEntries } from "./directory-reader.js";
import { ResourceBudget } from "./resource-budget.js";

let owned: string;
beforeEach(() => {
  owned = mkdtempSync(join(tmpdir(), "sweep-dir-reader-test-"));
  for (let i = 0; i < 65; i++) writeFileSync(join(owned, String(i)), "");
});
afterEach(() => rmSync(owned, { recursive: true, force: true }));

test("aborting a live reader rejects further entries", async () => {
  const budget = new ResourceBudget();
  const controller = new AbortController();
  const entries = directoryEntries(owned, budget, controller.signal);
  expect((await entries.next()).done).toBe(false);
  controller.abort();
  let caught: unknown;
  try {
    for await (const _entry of entries) {
      /* drain */
    }
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).name).toBe("AbortError");
});

test("closing an enumeration early allows another enumeration", async () => {
  const budget = new ResourceBudget();
  for await (const _entry of directoryEntries(owned, budget)) break;
  let count = 0;
  for await (const _entry of directoryEntries(owned, budget)) count++;
  expect(count).toBe(65);
});

test("dirent types classify files, dirs, and symlinks", async () => {
  mkdirSync(join(owned, "adir"));
  let linkCreated = false;
  try {
    symlinkSync("1", join(owned, "alink"));
    linkCreated = true;
  } catch (error) {
    // Windows may lack symlink privileges; still qualify ordinary dirents.
    if (
      process.platform !== "win32" ||
      !["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      throw error;
  }
  const types = new Map<string, string>();
  for await (const entry of directoryEntries(owned, new ResourceBudget())) {
    types.set(entry.name.toString("utf8"), entry.type);
  }
  expect(types.get("adir")).toBe("d");
  if (linkCreated) expect(types.get("alink")).toBe("l");
  expect(types.get("1")).toBe("f");
});

test.skipIf(process.platform !== "linux")(
  "invalid-UTF8 names survive with accurate dirent types",
  async () => {
    const raw = Buffer.from([0x62, 0x61, 0x64, 0xff, 0xfe]);
    // Buffer paths write the raw on-disk bytes - latin1/string writes would be
    // re-encoded to valid UTF-8 and defeat the test.
    writeFileSync(Buffer.concat([Buffer.from(owned + "/", "utf8"), raw]), "");
    const names: Buffer[] = [];
    for await (const entry of directoryEntries(owned, new ResourceBudget())) {
      names.push(entry.name);
      expect(entry.type).toBe("f");
    }
    expect(names.some((n) => n.equals(raw))).toBe(true);
  },
);

test("Bun fails explicitly when its incremental Node reader is unavailable", async () => {
  const source = `import {scan} from ${JSON.stringify(join(import.meta.dir, "scanner.ts"))}; import {DEFAULT_CONFIG} from ${JSON.stringify(join(import.meta.dir, "config.ts"))}; try { await scan(${JSON.stringify(owned)}, DEFAULT_CONFIG); process.exit(9); } catch (error) { console.error(error.message); process.exit(2); }`;
  const proc = Bun.spawn([process.execPath, "-e", source], {
    env: { ...process.env, PATH: join(owned, "no-runtime") },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(code).toBe(2);
  expect(error).toContain("install Node or use the Rust engine");
});
