import { closeSync, openSync, readSync } from "node:fs";
import { isPathWithinRoot } from "./guardrails.js";

/** Linux mountinfo lists bind mounts separately even when st_dev is equal. */
export function mountPointsFromInfo(text: string): string[] {
  const result: string[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const fields = line.split(" ");
    if (fields.length < 10 || !fields.includes("-") || !fields[4]?.startsWith("/"))
      throw new Error("could not validate Linux mount table");
    result.push(
      fields[4].replace(/\\(040|011|012|134)/g, (_, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
      ),
    );
  }
  if (result.length === 0) throw new Error("Linux mount table is empty");
  return result;
}

export function readLinuxMountPoints(): string[] {
  const fd = openSync("/proc/self/mountinfo", "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (read === 0) return mountPointsFromInfo(buffer.toString("utf8", 0, bytes));
      bytes += read;
    }
    throw new Error("Linux mount table exceeded 1 MiB; refusing unchecked removal");
  } finally {
    closeSync(fd);
  }
}

/** Snapshot preflight only; JS has no descriptor-relative recursive remover. */
export function assertNoMountsWithin(candidate: string, mounts: readonly string[]): void {
  if (mounts.some((mount) => isPathWithinRoot(mount, candidate)))
    throw Object.assign(
      new Error("candidate contains a mounted filesystem; refusing recursive removal"),
      { code: "EOUTSIDE" },
    );
}
