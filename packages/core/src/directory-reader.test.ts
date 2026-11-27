import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { directoryEntries, disposeDirectoryReader } from "./directory-reader.js";
import { lookupExecutable } from "./executable-lookup.js";
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
  await disposeDirectoryReader(budget);
});

test("disposeDirectoryReader waits for the Node worker to exit before returning", async () => {
  const nodePath = lookupExecutable("node").resolvedPath;
  if (!nodePath) return;
  const binDir = mkdtempSync(join(tmpdir(), "sweep-dir-reader-bin-"));
  const target = join(binDir, basename(nodePath));
  if (process.platform === "win32") copyFileSync(nodePath, target);
  else symlinkSync(nodePath, target);

  const previousPath = process.env.PATH;
  const budget = new ResourceBudget();
  try {
    process.env.PATH = binDir;
    let count = 0;
    for await (const _entry of directoryEntries(owned, budget)) count++;
    expect(count).toBe(65);
    await disposeDirectoryReader(budget);
    rmSync(binDir, { recursive: true, force: true });
    expect(existsSync(binDir)).toBe(false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await disposeDirectoryReader(budget);
    rmSync(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
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

test("Bun reports a runtime-missing error (not a resource budget error) when Node is unavailable", async () => {
  const source = `import {scan} from ${JSON.stringify(join(import.meta.dir, "scanner.ts"))}; import {DEFAULT_CONFIG} from ${JSON.stringify(join(import.meta.dir, "config.ts"))}; try { await scan(${JSON.stringify(owned)}, DEFAULT_CONFIG); process.exit(9); } catch (error) { console.error(error.name + ": " + error.message); process.exit(2); }`;
  const proc = Bun.spawn([process.execPath, "-e", source], {
    env: { ...process.env, PATH: join(owned, "no-runtime") },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(code).toBe(2);
  expect(error).toContain("DirectoryReaderRuntimeError");
  expect(error).toContain("install Node or use the Rust engine");
  expect(error.toLowerCase()).not.toContain("resource limit");
  expect(error.toLowerCase()).not.toContain("smaller subtree");
});

test("Bun directory reader never runs a planted node binary from cwd via empty or relative PATH", async () => {
  const relDir = join(owned, "relbin");
  mkdirSync(relDir, { recursive: true });
  const marker = join(owned, "node-ran.marker");
  const ext = process.platform === "win32" ? ".exe" : "";
  const plantedCwd = join(owned, `node${ext}`);
  const plantedRel = join(relDir, `node${ext}`);
  if (process.platform === "win32") {
    copyFileSync(process.execPath, plantedCwd);
    copyFileSync(process.execPath, plantedRel);
  } else {
    const script = `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\nexit 0\n`;
    writeFileSync(plantedCwd, script);
    writeFileSync(plantedRel, script);
    chmodSync(plantedCwd, 0o755);
    chmodSync(plantedRel, 0o755);
  }

  const badPaths =
    process.platform === "win32"
      ? ["", ";C:\\nonexistent-node-dir", "C:\\nonexistent-node-dir;", ".", ".\\relbin"]
      : ["", ":/nonexistent-node-dir", "/nonexistent-node-dir:", "/a::/b", ".", "./relbin"];

  const source = `import {scan} from ${JSON.stringify(join(import.meta.dir, "scanner.ts"))}; import {DEFAULT_CONFIG} from ${JSON.stringify(join(import.meta.dir, "config.ts"))}; try { await scan(${JSON.stringify(owned)}, DEFAULT_CONFIG); process.exit(9); } catch (error) { console.error(error.name + ": " + error.message); process.exit(2); }`;

  const baseEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() === "PATH") continue;
    baseEnv[k] = v;
  }

  for (const pathEnv of badPaths) {
    const proc = Bun.spawn([process.execPath, "-e", source], {
      cwd: owned,
      env: { ...baseEnv, PATH: pathEnv },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(2);
    expect(error).toContain("DirectoryReaderRuntimeError");
    expect(error).toContain("Node.js runtime unavailable");
    expect(existsSync(marker)).toBe(false);
  }
});

test.skipIf(process.platform === "win32")(
  "a malformed reader response cannot become a complete scan with skipped directories",
  async () => {
    const bin = join(owned, "bin");
    mkdirSync(bin);
    const executable = join(bin, "node");
    writeFileSync(
      executable,
      `#!${process.execPath}
// Emit an invalid reply without waiting for input; a reader must fail closed.
process.stdout.write("not-json\\n");
setInterval(() => {}, 1000);
`,
    );
    chmodSync(executable, 0o700);
    const source = `import {scan} from ${JSON.stringify(join(import.meta.dir, "scanner.ts"))}; import {DEFAULT_CONFIG} from ${JSON.stringify(join(import.meta.dir, "config.ts"))}; try { await scan(${JSON.stringify(owned)}, DEFAULT_CONFIG); process.exit(9); } catch (error) { console.error(error.message); process.exit(2); }`;
    const proc = Bun.spawn([process.execPath, "-e", source], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(2);
    expect(error).toContain("incremental directory reader");
  },
);
