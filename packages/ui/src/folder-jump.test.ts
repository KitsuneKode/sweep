import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ago,
  discoverJumpTargets,
  fuzzyScore,
  rankJumpTargets,
  tildePath,
  typedPath,
} from "./folder-jump.js";

let root: string;
const dir = (...parts: string[]) => {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sweep-jump-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("folder jump discovery", () => {
  test("offers up, projects inside (two levels) and projects beside, never build output", () => {
    const here = dir("work", "mono");
    writeFileSync(join(dir("work", "mono", "apps", "web"), "package.json"), "{}");
    writeFileSync(join(dir("work", "mono", "crate"), "Cargo.toml"), "");
    dir("work", "mono", "node_modules", "pkg");
    writeFileSync(join(dir("work", "mono", "node_modules", "pkg"), "package.json"), "{}");
    dir("work", "notes");
    dir("work", "api", ".git");

    const targets = discoverJumpTargets(here);
    const byPath = new Map(targets.map((target) => [target.path, target]));
    expect(targets[0]).toEqual({ path: join(root, "work"), source: "up" });
    expect(byPath.get(join(here, "apps", "web"))?.detail).toBe("node");
    expect(byPath.get(join(here, "crate"))?.detail).toBe("rust");
    expect([...byPath.keys()].some((path) => path.includes("node_modules"))).toBe(false);
    // Beside: the git project sorts before the plain folder.
    const beside = targets.filter((target) => target.source === "beside").map((t) => t.path);
    expect(beside).toEqual([join(root, "work", "api"), join(root, "work", "notes")]);
    expect(targets.some((target) => target.path === here)).toBe(false);
  });

  test("folders cleaned before are offered when they still exist", () => {
    const here = dir("a");
    const cleaned = dir("b");
    const now = Date.parse("2026-10-26T12:00:00Z");
    const targets = discoverJumpTargets(
      here,
      [
        { targetDir: cleaned, ts: "2026-10-23T12:00:00Z", bytesFreed: 1 },
        { targetDir: join(root, "gone"), ts: "2026-10-23T12:00:00Z", bytesFreed: 1 },
      ],
      now,
      "/nonexistent-scratch",
    );
    expect(targets.find((target) => target.path === cleaned)).toEqual({
      path: cleaned,
      source: "cleaned",
      detail: "cleaned 3d ago",
    });
    expect(targets.some((target) => target.path.endsWith("gone"))).toBe(false);
    // Scratch folders cleaned once are not offered back.
    const scratch = discoverJumpTargets(
      here,
      [{ targetDir: cleaned, ts: "2026-10-23T12:00:00Z", bytesFreed: 1 }],
      now,
      root,
    );
    expect(scratch.some((target) => target.source === "cleaned")).toBe(false);
  });
});

describe("folder jump ranking", () => {
  test("fuzzy matches favour segment starts and the folder's own name", () => {
    expect(fuzzyScore("swp", "~/Projects/sweep")).not.toBeNull();
    expect(fuzzyScore("xyz", "~/Projects/sweep")).toBeNull();
    const name = fuzzyScore("web", "~/mono/apps/web")!;
    const scattered = fuzzyScore("web", "~/work/eb-notes/b")!;
    expect(name).toBeGreaterThan(scattered);
  });

  test("a typed path is taken literally and completed from its parent", () => {
    const here = dir("x");
    dir("projects", "alpha");
    dir("projects", "beta");
    expect(typedPath("../projects", here)).toBe(join(root, "projects"));
    expect(typedPath("sweep", here)).toBeNull();
    const ranked = rankJumpTargets([], "../projects/al", here);
    expect(ranked.map((target) => target.path)).toEqual([join(root, "projects", "alpha")]);
    const inside = rankJumpTargets([], "../projects", here).map((target) => target.path);
    expect(inside[0]).toBe(join(root, "projects"));
    expect(inside).toContain(join(root, "projects", "beta"));
  });

  test("display helpers", () => {
    expect(tildePath("/home/me/code", "/home/me")).toBe("~/code");
    expect(tildePath("/home/meadow", "/home/me")).toBe("/home/meadow");
    const now = Date.parse("2026-10-26T12:00:00Z");
    expect(ago("2026-10-26T11:30:00Z", now)).toBe("30m ago");
    expect(ago("2026-10-26T07:00:00Z", now)).toBe("5h ago");
    expect(ago("not a date", now)).toBe("recently");
  });
});

describe("jump labels", () => {
  test("read relative to the folder under review", async () => {
    const { jumpLabel } = await import("./folder-jump.js");
    expect(jumpLabel({ path: "/w/mono/apps/web", source: "inside" }, "/w/mono", "/h")).toBe(
      "./apps/web",
    );
    expect(jumpLabel({ path: "/w/api", source: "beside" }, "/w/mono", "/h")).toBe("../api");
    expect(jumpLabel({ path: "/h/code", source: "cleaned" }, "/w/mono", "/h")).toBe("~/code");
  });
});
