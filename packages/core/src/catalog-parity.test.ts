import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_ARTIFACT_NAMES } from "@kitsunekode/sweep-protocol";
import { PATTERN_CATALOG } from "./catalog.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function constGroups(source: string, name: string): string[][] {
  const start = source.indexOf(`const ${name}`);
  if (start < 0) throw new Error(`missing ${name}`);
  const end = source.indexOf("];", start);
  const groups: string[][] = [];
  for (const line of source.slice(start, end).split("\n")) {
    const names = [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    if (names.length > 0) groups.push(names);
  }
  return groups;
}

function rustFnStrings(source: string, name: string): string[] {
  const start = source.indexOf(`pub fn ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  const end = source.indexOf("\n}", start);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

describe("JS and Rust catalogs", () => {
  const fsSource = readFileSync(join(ROOT, "crates/sweep-fs/src/lib.rs"), "utf8");
  const classify = readFileSync(join(ROOT, "crates/sweep-engine/src/classify.rs"), "utf8");
  const engine = readFileSync(join(ROOT, "crates/sweep-engine/src/lib.rs"), "utf8");
  const classification = readFileSync(join(ROOT, "packages/core/src/classification.ts"), "utf8");

  test("default and opt-in pattern sets match", () => {
    const defaults = PATTERN_CATALOG.filter((entry) => entry.byDefault).map(
      (entry) => entry.pattern,
    );
    const optIn = PATTERN_CATALOG.filter((entry) => !entry.byDefault).map((entry) => entry.pattern);
    expect(rustFnStrings(fsSource, "default_patterns").sort()).toEqual([...defaults].sort());
    expect(rustFnStrings(fsSource, "opt_in_patterns").sort()).toEqual([...optIn].sort());
  });

  test("tool-home prefixes match", () => {
    for (const name of ["HOME_TOOL_DIRS", "HOME_TOOL_EXCEPTIONS", "SYSTEM_TOOL_DIRS"]) {
      expect(constGroups(classify, name)).toEqual(constGroups(classification, name));
    }
  });

  test("candidate kind names match", () => {
    const start = engine.indexOf("fn candidate_kind_from_name");
    const end = engine.indexOf("_ if name.ends_with", start);
    const names = [...engine.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    expect(names.sort()).toEqual([...KNOWN_ARTIFACT_NAMES].sort());
  });

  test("target markers are a real Cargo.toml or CACHEDIR.TAG", () => {
    const target = PATTERN_CATALOG.find((entry) => entry.pattern === "target");
    expect(target?.markers).toEqual({
      siblings: ["Cargo.toml"],
      inside: ["CACHEDIR.TAG"],
    });
    expect(fsSource).toContain('sibling_markers: &["Cargo.toml"]');
    expect(fsSource).toContain('inside_markers: &["CACHEDIR.TAG"]');
  });
});
