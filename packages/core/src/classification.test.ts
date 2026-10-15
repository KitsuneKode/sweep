import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanEntry } from "@kitsunekode/sweep-protocol";
import { isInsideToolHome } from "./classification.js";
import { classifyEntry, toCandidate } from "./planner.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sweep-classification-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entry(path: string, name: string, entryType: ScanEntry["entryType"]): ScanEntry {
  return { path, name, entryType, isSymlink: false, estimatedBytes: 0 };
}

function dir(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function file(contents: string, ...parts: string[]): string {
  const path = join(root, ...parts);
  writeFileSync(path, contents);
  return path;
}

describe("default names need context to be safe", () => {
  test("a regular file named target is not cargo output", () => {
    dir("docs");
    const path = file("my notes\n", "docs", "target");
    const result = classifyEntry(entry(path, "target", "file"));
    expect(result.riskTier).toBe("dangerous");
    expect(result.reasons).toEqual(["default-pattern", "entry-type-mismatch"]);
    expect(toCandidate(entry(path, "target", "file")).selectedByDefault).toBe(false);
  });

  test("an authored target folder without a cargo marker is not presumed safe", () => {
    const path = dir("notes", "target");
    file("authored essay\n", "notes", "target", "chapter1.md");
    const result = classifyEntry(entry(path, "target", "directory"));
    expect(result.riskTier).toBe("dangerous");
    expect(result.reasons).toEqual(["default-pattern", "no-project-marker"]);
  });

  test("target beside Cargo.toml stays safe", () => {
    const path = dir("crate", "target");
    file("[package]\n", "crate", "Cargo.toml");
    expect(classifyEntry(entry(path, "target", "directory"))).toEqual({
      riskTier: "safe",
      reasons: ["default-pattern"],
    });
  });

  test("target carrying cargo's CACHEDIR.TAG stays safe without a manifest", () => {
    const path = dir("custom-target-dir", "target");
    file(
      "Signature: 8a477f597d28d172789f06886806bc55\n",
      "custom-target-dir",
      "target",
      "CACHEDIR.TAG",
    );
    expect(classifyEntry(entry(path, "target", "directory")).riskTier).toBe("safe");
  });

  test("a directory named Cargo.toml is not a manifest", () => {
    const path = dir("odd", "target");
    dir("odd", "Cargo.toml");
    expect(classifyEntry(entry(path, "target", "directory")).reasons).toContain(
      "no-project-marker",
    );
  });

  test("a directory named like a tsbuildinfo file is a type mismatch", () => {
    const path = dir("pkg", "tsconfig.tsbuildinfo");
    expect(classifyEntry(entry(path, "tsconfig.tsbuildinfo", "directory")).reasons).toContain(
      "entry-type-mismatch",
    );
  });

  test("node_modules needs no marker", () => {
    const path = dir("app", "node_modules");
    expect(classifyEntry(entry(path, "node_modules", "directory")).riskTier).toBe("safe");
  });

  test("node_modules inside a system app install is a tool home", () => {
    const result = classifyEntry(
      entry("/usr/share/cursor/resources/app/node_modules", "node_modules", "directory"),
    );
    expect(result.riskTier).toBe("dangerous");
    expect(result.reasons).toEqual(["default-pattern", "tool-home"]);
  });

  test("symlinks keep the caution tier and gain no context reason", () => {
    const result = classifyEntry({
      ...entry(join(root, "target"), "target", "symlink"),
      isSymlink: true,
    });
    expect(result).toEqual({ riskTier: "caution", reasons: ["symlink", "default-pattern"] });
  });
});

describe("isInsideToolHome", () => {
  const home = "/home/dev";

  test.each([
    "/home/dev/.bun/install/global/node_modules",
    "/home/dev/.bun/install/cache/links/zod/node_modules",
    "/home/dev/.local/share/zed/prettier/node_modules",
    "/home/dev/.local/share/nvim/lazy/blink.cmp/target",
    "/home/dev/.config/Cursor/node_modules",
    "/home/dev/.cargo/registry/src/x/target",
    "/home/dev/Applications/Editor.app/Contents/Resources/app/node_modules",
    "/usr/share/cursor/resources/app/node_modules",
    "/usr/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
    "/var/lib/docker/overlay2/abc/diff/app/node_modules",
    "/nix/store/abc-pkg/lib/node_modules",
  ])("protects %s", (path) => {
    expect(isInsideToolHome(path, home)).toBe(true);
  });

  test.each([
    "/home/dev/Projects/app/node_modules",
    "/home/dev/code/.github-like/target",
    "/home/devops/.bun/node_modules",
    "/var/www/site/node_modules",
    "/var/folders/xy/T/sweep-test/node_modules",
    "/tmp/sweep-test/node_modules",
    "/srv/app/node_modules",
  ])("leaves %s to the normal rules", (path) => {
    expect(isInsideToolHome(path, home)).toBe(false);
  });

  test.if(process.platform === "win32")("Windows app data is protected, temp is not", () => {
    const winHome = "C:\\Users\\dev";
    expect(isInsideToolHome("C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules", winHome)).toBe(
      true,
    );
    expect(isInsideToolHome("c:\\users\\DEV\\appdata\\local\\x\\node_modules", winHome)).toBe(true);
    expect(isInsideToolHome("C:\\Users\\dev\\AppData\\Local\\Temp\\t\\node_modules", winHome)).toBe(
      false,
    );
    expect(isInsideToolHome("D:\\Program Files\\App\\resources\\node_modules", winHome)).toBe(true);
  });

  test("an unset or root home disables home rules but keeps system rules", () => {
    expect(isInsideToolHome("/.bun/node_modules", "/")).toBe(false);
    expect(isInsideToolHome("/usr/share/x/node_modules", "")).toBe(true);
  });
});
