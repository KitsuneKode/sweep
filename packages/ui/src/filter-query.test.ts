import { describe, expect, test } from "bun:test";
import type { ScanCandidate } from "@kitsunekode/sweep-protocol";
import { compileFilter, filterAdvice } from "./filter-query.js";

const NOW = Date.UTC(2026, 8, 30);
const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

function candidate(overrides: Partial<ScanCandidate>): ScanCandidate {
  return {
    id: "c1",
    path: "/work/app/node_modules",
    name: "node_modules",
    kind: "node_modules",
    estimatedBytes: 10 * MB,
    isSymlink: false,
    entryType: "directory",
    riskTier: "safe",
    reasons: [],
    selectedByDefault: true,
    ...overrides,
  };
}

function matches(query: string, target: ScanCandidate, queued: string[] = []): boolean {
  const predicate = compileFilter(query);
  if (!predicate) return true;
  return predicate(target, { selectedIds: new Set(queued), now: NOW });
}

describe("compileFilter", () => {
  test("an empty box filters nothing", () => {
    expect(compileFilter("   ")).toBeNull();
  });

  test("bare words are substring matches over name, path, kind and risk", () => {
    expect(matches("node_mod", candidate({}))).toBe(true);
    expect(matches("app", candidate({}))).toBe(true);
    expect(matches("caution", candidate({ riskTier: "caution" }))).toBe(true);
    expect(matches("dist", candidate({}))).toBe(false);
  });

  test("every term must match", () => {
    expect(matches("app node", candidate({}))).toBe(true);
    expect(matches("app dist", candidate({}))).toBe(false);
  });

  test("size comparisons use binary units and accept short suffixes", () => {
    const big = candidate({ estimatedBytes: 200 * MB });
    expect(matches(">100MB", big)).toBe(true);
    expect(matches(">100m", big)).toBe(true);
    expect(matches("<100MB", big)).toBe(false);
    expect(matches(">=200mb", big)).toBe(true);
    expect(matches("<=1.5gb", big)).toBe(true);
  });

  test("kind, risk and path narrow by field", () => {
    const target = candidate({ kind: "target", name: "target", path: "/w/crate/target" });
    expect(matches("kind:targ", target)).toBe(true);
    expect(matches("kind:dist", target)).toBe(false);
    expect(matches("risk:safe", target)).toBe(true);
    expect(matches("risk:caution", target)).toBe(false);
    expect(matches("path:crate", target)).toBe(true);
  });

  test("older and newer compare against mtime and skip unknown mtimes", () => {
    const stale = candidate({ modifiedMs: NOW - 90 * DAY });
    const fresh = candidate({ modifiedMs: NOW - 2 * DAY });
    const unknown = candidate({});
    expect(matches("older:30d", stale)).toBe(true);
    expect(matches("older:30d", fresh)).toBe(false);
    expect(matches("newer:7d", fresh)).toBe(true);
    expect(matches("older:2mo", stale)).toBe(true);
    expect(matches("older:30d", unknown)).toBe(false);
    expect(matches("newer:30d", unknown)).toBe(false);
  });

  test("is: flags cover queue state, symlinks, stubs, files and directories", () => {
    expect(matches("is:queued", candidate({ id: "a" }), ["a"])).toBe(true);
    expect(matches("is:queued", candidate({ id: "a" }), [])).toBe(false);
    expect(matches("is:unqueued", candidate({ id: "a" }), [])).toBe(true);
    expect(matches("is:symlink", candidate({ isSymlink: true }))).toBe(true);
    expect(matches("is:stub", candidate({ reasons: ["workspace-stub"] }))).toBe(true);
    expect(matches("is:dir", candidate({ entryType: "directory" }))).toBe(true);
    expect(matches("is:dir", candidate({ entryType: "file" }))).toBe(false);
    expect(matches("is:file", candidate({ entryType: "file" }))).toBe(true);
    expect(matches("is:file", candidate({ entryType: "directory" }))).toBe(false);
  });

  test("a finished term that is not a filter explains itself", () => {
    expect(filterAdvice("")).toBeNull();
    expect(filterAdvice("kind:")).toBeNull();
    expect(filterAdvice(">100MB is:dir")).toBeNull();
    expect(filterAdvice("is:nope")).toContain("isn't a filter");
    expect(filterAdvice("older:x")).toContain("duration");
    expect(filterAdvice("risk:spicy")).toContain("isn't a tier");
    expect(filterAdvice("ecosystem:node")).toContain("isn't a filter");
  });

  test("a leading ! negates a term", () => {
    expect(matches("!kind:dist", candidate({}))).toBe(true);
    expect(matches("!kind:node", candidate({}))).toBe(false);
    expect(matches("!dist", candidate({}))).toBe(true);
  });

  test("half-typed operators fall back to text rather than hiding everything", () => {
    expect(matches(">1", candidate({ path: "/w/a>1/node_modules" }))).toBe(true);
    expect(matches("kind:", candidate({ path: "/w/kind:/node_modules" }))).toBe(true);
    expect(matches("older:x", candidate({}))).toBe(false);
  });

  test("terms combine: big, stale, and safe", () => {
    const target = candidate({ estimatedBytes: 300 * MB, modifiedMs: NOW - 120 * DAY });
    expect(matches(">100MB older:30d risk:safe", target)).toBe(true);
    expect(matches(">100MB older:30d risk:caution", target)).toBe(false);
  });
});
