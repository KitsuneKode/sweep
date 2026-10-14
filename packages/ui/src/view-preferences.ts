import { randomUUID } from "node:crypto";
import {
  type Stats,
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { sweepConfigDir } from "@kitsunekode/sweep-core/config";

export interface ViewPreferences {
  version: 1;
  themeMode: "auto" | "dark" | "light";
  sortBy: "size" | "name" | "age";
  motionEnabled: boolean;
}
const MAX_BYTES = 4096;
const FILE = "ui-preferences.json";
function validate(value: unknown): value is ViewPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    Object.keys(data).length === 4 &&
    data.version === 1 &&
    typeof data.themeMode === "string" &&
    ["auto", "dark", "light"].includes(data.themeMode) &&
    typeof data.sortBy === "string" &&
    ["size", "name", "age"].includes(data.sortBy) &&
    typeof data.motionEnabled === "boolean"
  );
}
function owned(meta: Stats): boolean {
  return (
    !meta.isSymbolicLink() &&
    (!process.getuid || meta.uid === process.getuid()) &&
    (process.platform === "win32" || (meta.mode & 0o022) === 0)
  );
}
function directory(root: string) {
  const meta = lstatSync(root);
  if (!meta.isDirectory() || !owned(meta))
    throw new Error("Unsafe appearance preferences directory");
  return meta;
}

/** Display-only input: malformed, missing or unsafe preferences use defaults. */
export function loadViewPreferences(root = sweepConfigDir()): ViewPreferences | undefined {
  let fd: number | undefined;
  try {
    directory(root);
    const path = join(root, FILE);
    const before = lstatSync(path);
    if (!before.isFile() || !owned(before) || before.size > MAX_BYTES) return;
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const meta = fstatSync(fd);
    if (
      !meta.isFile() ||
      !owned(meta) ||
      meta.dev !== before.dev ||
      meta.ino !== before.ino ||
      meta.size > MAX_BYTES
    )
      return;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > MAX_BYTES) return;
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)),
    );
    return validate(value) ? value : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Appearance loading falls back to defaults. */
      }
    }
  }
}

/** Persist only presentation settings. Never store paths, selections or apply options. */
export function saveViewPreferences(value: ViewPreferences, root = sweepConfigDir()): void {
  if (!validate(value)) throw new Error("Invalid appearance preferences");
  root = resolve(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const before = directory(root);
  const path = join(root, FILE);
  try {
    const current = lstatSync(path);
    if (!current.isFile() || !owned(current)) throw new Error("Unsafe appearance preferences file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(root, `.ui-preferences-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let failure: unknown;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const current = directory(root);
    if (current.dev !== before.dev || current.ino !== before.ino)
      throw new Error("Appearance preferences directory changed");
    renameSync(temporary, path);
  } catch (error) {
    failure = error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}
