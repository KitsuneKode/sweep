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

test.skipIf(process.platform === "win32")(
  "a replaced trash reservation cannot redirect the move",
  async () => {
    const fs = await import("node:fs");
    const { spyOn } = await import("bun:test");
    const owned = mkdtempSync(join(tmpdir(), "sweep-trash-slot-swap-"));
    const source = join(owned, "source");
    const slot = join(owned, "slot");
    const outside = join(owned, "outside");
    const originalStat = fs.statSync;
    let parentChecks = 0;
    const spy = spyOn(fs, "statSync");
    try {
      mkdirSync(source);
      mkdirSync(outside);
      writeFileSync(join(source, "keep"), "source data");
      spy.mockImplementation(((
        path: Parameters<typeof fs.statSync>[0],
        options: Parameters<typeof fs.statSync>[1],
      ) => {
        if (path === owned && ++parentChecks === 2) {
          fs.renameSync(slot, join(owned, "reserved"));
          fs.symlinkSync(outside, slot);
        }
        return originalStat(path, options);
      }) as typeof fs.statSync);
      await expect(moveIntoTrashSlot(source, slot)).rejects.toThrow("changed");
      expect(readFileSync(join(source, "keep"), "utf8")).toBe("source data");
      expect(existsSync(join(outside, "payload"))).toBe(false);
    } finally {
      spy.mockRestore();
      rmSync(owned, { recursive: true, force: true });
    }
  },
);
