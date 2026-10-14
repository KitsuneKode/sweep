import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadViewPreferences,
  saveViewPreferences,
  type ViewPreferences,
} from "./view-preferences.js";
const roots: string[] = [];
const directory = () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-view-prefs-"));
  roots.push(root);
  return root;
};
const value: ViewPreferences = {
  version: 1,
  themeMode: "light",
  sortBy: "age",
  motionEnabled: false,
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("preferences persist only appearance, replace atomically and leave no staging files", () => {
  const root = directory();
  expect(loadViewPreferences(root)).toBeUndefined();
  saveViewPreferences(value, root);
  expect(loadViewPreferences(root)).toEqual(value);
  saveViewPreferences({ ...value, sortBy: "size" }, root);
  expect(loadViewPreferences(root)?.sortBy).toBe("size");
  expect(readdirSync(root)).toEqual(["ui-preferences.json"]);
  expect(() =>
    saveViewPreferences({ ...value, selectedIds: ["unreviewed"] } as ViewPreferences, root),
  ).toThrow();
  expect(loadViewPreferences(root)?.sortBy).toBe("size");
});
test("malformed, oversized and hidden-intent preferences are ignored", () => {
  const root = directory();
  for (const input of [
    "null",
    "[]",
    "{",
    " ".repeat(4097),
    JSON.stringify({ ...value, trash: true }),
    JSON.stringify({ ...value, themeMode: ["light"] }),
  ]) {
    writeFileSync(join(root, "ui-preferences.json"), input, { mode: 0o600 });
    expect(loadViewPreferences(root)).toBeUndefined();
  }
});
test.skipIf(process.platform === "win32")(
  "symlinked preferences and directories cannot read or overwrite other files",
  () => {
    const root = directory();
    const outside = directory();
    const victim = join(outside, "other.json");
    writeFileSync(victim, JSON.stringify(value), { mode: 0o600 });
    symlinkSync(victim, join(root, "ui-preferences.json"));
    expect(loadViewPreferences(root)).toBeUndefined();
    expect(() => saveViewPreferences(value, root)).toThrow();
    expect(readFileSync(victim, "utf8")).toBe(JSON.stringify(value));
    const alias = join(root, "alias");
    symlinkSync(outside, alias);
    expect(loadViewPreferences(alias)).toBeUndefined();
    expect(() => saveViewPreferences(value, alias)).toThrow();
    expect(readdirSync(outside)).toEqual(["other.json"]);
  },
);
