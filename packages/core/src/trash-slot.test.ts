import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveIntoTrashSlot } from "./trash-slot.js";

test("reserved trash slots move files and directories without replacing an existing slot", async () => {
  const owned = mkdtempSync(join(tmpdir(), "sweep-trash-slot-"));
  try {
    const source = join(owned, "source");
    const slot = join(owned, "slot");
    mkdirSync(source);
    writeFileSync(join(source, "keep"), "directory contents");
    await moveIntoTrashSlot(source, slot);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(join(slot, "payload", "keep"), "utf8")).toBe("directory contents");
    writeFileSync(source, "file contents");
    await expect(moveIntoTrashSlot(source, slot)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(source, "utf8")).toBe("file contents");
    expect(readFileSync(join(slot, "payload", "keep"), "utf8")).toBe("directory contents");
    await moveIntoTrashSlot(source, join(owned, "file-slot"));
    expect(readFileSync(join(owned, "file-slot", "payload"), "utf8")).toBe("file contents");
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
});

test("failed trash moves release only their empty reserved slot", async () => {
  const owned = mkdtempSync(join(tmpdir(), "sweep-trash-slot-failure-"));
  try {
    const slot = join(owned, "slot");
    await expect(moveIntoTrashSlot(join(owned, "missing"), slot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(existsSync(slot)).toBe(false);
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
});
