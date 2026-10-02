import { describe, expect, test } from "bun:test";
import { compileGlobMatchers, globMatch } from "./glob-match.js";

describe("globMatch", () => {
  test("star matches any run including slashes", () => {
    expect(globMatch("*", "anything/with/slashes")).toBe(true);
    expect(globMatch("dist*", "dist")).toBe(true);
    expect(globMatch("*.map", "app.js.map")).toBe(true);
    expect(globMatch("a*c*e", "abXcdYe")).toBe(true);
    expect(globMatch("a*c*e", "abXcdYef")).toBe(false);
  });

  test("star does not overreach", () => {
    expect(globMatch("*.map", "app.map.js")).toBe(false);
    expect(globMatch("a*c*e", "abXcdYfx")).toBe(false);
    expect(globMatch("dist", "dist2")).toBe(false);
  });

  test("question mark is exactly one char", () => {
    expect(globMatch("?", "x")).toBe(true);
    expect(globMatch("?", "")).toBe(false);
    expect(globMatch("?", "xy")).toBe(false);
    expect(globMatch("foo?", "foo1")).toBe(true);
    expect(globMatch("foo?", "foo")).toBe(false);
  });

  test("empty pattern only matches empty name", () => {
    expect(globMatch("", "")).toBe(true);
    expect(globMatch("", "x")).toBe(false);
  });

  test("pathological pattern stays bounded", () => {
    // Audit A01: star-heavy pattern vs a long non-matching name must not
    // explode into backtracking - this is the class regexes failed on.
    const pattern = `${"*a".repeat(64)}*b`;
    const name = "a".repeat(200);
    const start = performance.now();
    const result = globMatch(pattern, name);
    expect(performance.now() - start).toBeLessThan(100);
    expect(result).toBe(false);
  });
});

describe("compileGlobMatchers", () => {
  test("exact patterns use the set, globs use the matcher", () => {
    const matches = compileGlobMatchers(["dist", "*.map"], false);
    expect(matches("dist")).toBe(true);
    expect(matches("app.js.map")).toBe(true);
    expect(matches("dist2")).toBe(false);
    expect(matches("app.map.js")).toBe(false);
  });

  test("case-insensitive mode folds both sides", () => {
    const matches = compileGlobMatchers(["Dist*"], true);
    expect(matches("DIST-folder")).toBe(true);
    expect(matches("other")).toBe(false);
  });

  test("a ?-only pattern is a glob, not an exact entry", () => {
    // Regression: the old splitter put non-`*` patterns in the exact set, so
    // `foo?` sat in the set AND the regexes - the set entry never matched.
    const matches = compileGlobMatchers(["foo?"], false);
    expect(matches("foo1")).toBe(true);
    expect(matches("foo")).toBe(false);
    // `?` is a wildcard, so it matches a literal `?` in the name too.
    expect(matches("foo?")).toBe(true);
  });
});

test("question marks consume Unicode scalar values like Rust", () => {
  expect(globMatch("?", "🦊")).toBe(true);
  expect(globMatch("??", "🦊")).toBe(false);
  expect(globMatch("🦊*?", "🦊ab")).toBe(true);
  expect(globMatch("*🦊?", "abc🦊x")).toBe(true);
});

test("Unicode case folding agrees with native patterns", () => {
  const matches = compileGlobMatchers(["Ä*", "ΟΣ"], true);
  expect(matches("ä-cache")).toBe(true);
  expect(matches("ος")).toBe(true);
});
