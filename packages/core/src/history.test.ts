import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  ftruncateSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistory, readHistory, summarizeHistory } from "./history.js";

describe("history", () => {
  const originalXdg = process.env.XDG_CONFIG_HOME;
  let sandbox = "";

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = "";
  });

  test("appends and reads back entries oldest-first", () => {
    sandbox = mkdtempSync(join(tmpdir(), "sweep-history-"));
    process.env.XDG_CONFIG_HOME = sandbox;

    expect(
      appendHistory({
        ts: "2025-01-01T00:00:00.000Z",
        targetDir: "/tmp/project",
        engine: "js",
        deleted: 3,
        bytesFreed: 1024,
        failed: 0,
        interrupted: false,
      }),
    ).toBe(true);
    appendHistory({
      ts: "2025-01-02T00:00:00.000Z",
      targetDir: "/tmp/other",
      engine: "rust",
      deleted: 1,
      bytesFreed: 2048,
      failed: 1,
      interrupted: false,
      trashDir: "/tmp/other/.sweep-trash-x",
    });

    const entries = readHistory();
    expect(entries.length).toBe(2);
    expect(entries[0]?.targetDir).toBe("/tmp/project");
    expect(entries[1]?.trashDir).toBe("/tmp/other/.sweep-trash-x");

    const summary = summarizeHistory(entries);
    expect(summary.sessions).toBe(2);
    expect(summary.totalBytesFreed).toBe(3072);
    expect(summary.totalFailed).toBe(1);
    expect(summary.lastAt).toBe("2025-01-02T00:00:00.000Z");
  });

  test("skips malformed lines instead of failing", () => {
    sandbox = mkdtempSync(join(tmpdir(), "sweep-history-"));
    process.env.XDG_CONFIG_HOME = sandbox;
    appendHistory({
      ts: "2025-01-01T00:00:00.000Z",
      targetDir: "/tmp/a",
      engine: "js",
      deleted: 1,
      bytesFreed: 1,
      failed: 0,
      interrupted: false,
    });
    writeFileSync(
      join(sandbox, "sweep", "history.jsonl"),
      'garbage\n{"ts":5}\n{"ts":"2025-01-03T00:00:00.000Z","targetDir":"/tmp/b","engine":"js","deleted":2,"bytesFreed":9,"failed":0,"interrupted":false}\n',
      { flag: "a" },
    );

    const entries = readHistory();
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.targetDir)).toEqual(["/tmp/a", "/tmp/b"]);
  });

  test("returns empty when no history file exists", () => {
    sandbox = mkdtempSync(join(tmpdir(), "sweep-history-"));
    process.env.XDG_CONFIG_HOME = sandbox;
    expect(readHistory()).toEqual([]);
    expect(summarizeHistory([]).sessions).toBe(0);
  });

  test("a torn final record does not swallow the next completed append", () => {
    sandbox = mkdtempSync(join(tmpdir(), "sweep-history-"));
    process.env.XDG_CONFIG_HOME = sandbox;
    const entry = {
      ts: "2025-01-01T00:00:00.000Z",
      targetDir: "/tmp/completed",
      engine: "js" as const,
      deleted: 1,
      bytesFreed: 123,
      failed: 0,
      interrupted: false,
    };
    expect(appendHistory(entry)).toBe(true);
    writeFileSync(join(sandbox, "sweep", "history.jsonl"), '{"ts":"unfinished', { flag: "a" });
    expect(appendHistory({ ...entry, targetDir: "/tmp/next" })).toBe(true);
    expect(readHistory().map((record) => record.targetDir)).toEqual([
      "/tmp/completed",
      "/tmp/next",
    ]);
  });
  test("reads only the bounded tail of a sparse oversized log", () => {
    sandbox = mkdtempSync(join(tmpdir(), "sweep-history-"));
    process.env.XDG_CONFIG_HOME = sandbox;
    const entry = {
      ts: "2025-01-01T00:00:00.000Z",
      targetDir: "/tmp/🦊",
      engine: "js",
      deleted: 1,
      bytesFreed: 4,
      failed: 0,
      interrupted: false,
    };
    appendHistory(entry);
    const file = join(sandbox, "sweep", "history.jsonl");
    const fd = openSync(file, "w");
    ftruncateSync(fd, 128 * 1024 * 1024);
    closeSync(fd);
    writeFileSync(file, `\n${JSON.stringify(entry)}\n`, { flag: "a" });
    expect(readHistory()).toEqual([entry]);
    expect(readHistory(0)).toEqual([]);
  });
  test("rotation preserves the existing log as a private archive", () => {
    sandbox = mkdtempSync(join(tmpdir(), "sweep-history-"));
    process.env.XDG_CONFIG_HOME = sandbox;
    const entry = {
      ts: "2025-01-01T00:00:00.000Z",
      targetDir: "/tmp/a",
      engine: "js",
      deleted: 1,
      bytesFreed: 4,
      failed: 0,
      interrupted: false,
    };
    appendHistory(entry);
    const file = join(sandbox, "sweep", "history.jsonl");
    const fd = openSync(file, "r+");
    ftruncateSync(fd, 17 * 1024 * 1024);
    closeSync(fd);
    expect(appendHistory(entry)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(readHistory()).toEqual([entry]);
  });
  test.skipIf(process.platform === "win32")(
    "never reads or appends through a history symlink",
    () => {
      sandbox = mkdtempSync(join(tmpdir(), "sweep-history-"));
      process.env.XDG_CONFIG_HOME = sandbox;
      const entry = {
        ts: "2025-01-01T00:00:00.000Z",
        targetDir: "/tmp/a",
        engine: "js",
        deleted: 1,
        bytesFreed: 4,
        failed: 0,
        interrupted: false,
      };
      appendHistory(entry);
      const file = join(sandbox, "sweep", "history.jsonl");
      const outside = join(sandbox, "outside");
      writeFileSync(outside, JSON.stringify(entry) + "\n");
      rmSync(file);
      symlinkSync(outside, file);
      expect(readHistory()).toEqual([]);
      expect(appendHistory(entry)).toBe(false);
    },
  );
});
