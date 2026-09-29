import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
