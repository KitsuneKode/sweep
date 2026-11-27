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
  const eq = source.indexOf("=", start);
  const open = source.indexOf("[", eq);
  const end = source.indexOf("];", open);
  const groups: string[][] = [];
  for (const group of source.slice(open + 1, end).matchAll(/\[([^[\]]+)\]/g)) {
    const names = [...group[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    if (names.length > 0) groups.push(names);
  }
  return groups;
}

function constStrings(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}`);
  if (start < 0) throw new Error(`missing ${name}`);
  const end = source.indexOf("];", start);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
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
  const rustGuardrails = readFileSync(join(ROOT, "crates/sweep-engine/src/guardrails.rs"), "utf8");
  const engine = readFileSync(join(ROOT, "crates/sweep-engine/src/lib.rs"), "utf8");
  const classification = readFileSync(join(ROOT, "packages/core/src/classification.ts"), "utf8");
  const tsGuardrails = readFileSync(join(ROOT, "packages/core/src/guardrails.ts"), "utf8");

  test("default and opt-in pattern sets match", () => {
    const defaults = PATTERN_CATALOG.filter((entry) => entry.byDefault).map(
      (entry) => entry.pattern,
    );
    const optIn = PATTERN_CATALOG.filter((entry) => !entry.byDefault).map((entry) => entry.pattern);
    expect(rustFnStrings(fsSource, "default_patterns").sort()).toEqual([...defaults].sort());
    expect(rustFnStrings(fsSource, "opt_in_patterns").sort()).toEqual([...optIn].sort());
  });

  test("tool-home and cloud-sync prefixes match", () => {
    for (const name of [
      "HOME_TOOL_DIRS",
      "HOME_TOOL_EXCEPTIONS",
      "SYSTEM_TOOL_DIRS",
      "UNIX_SYSTEM_TOOL_DIRS",
      "UNIX_SYSTEM_TOOL_EXCEPTIONS",
      "CLOUD_SYNC_HOME_DIRS",
    ]) {
      expect(constGroups(classify, name)).toEqual(constGroups(classification, name));
    }
    expect(constStrings(classify, "CLOUD_SYNC_HOME_PREFIXES")).toEqual(
      constStrings(classification, "CLOUD_SYNC_HOME_PREFIXES"),
    );
  });

  test("guardrail root lists match", () => {
    for (const name of [
      "DARWIN_SYSTEM_ROOTS",
      "UNIX_PREFIX_BLOCKED_ROOTS",
      "UNIX_PREFIX_BLOCKED_EXCEPTIONS",
    ]) {
      expect(constStrings(rustGuardrails, name)).toEqual(constStrings(tsGuardrails, name));
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
