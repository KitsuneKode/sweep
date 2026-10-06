import { lstatSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Windows cannot rename a directory over an empty directory placeholder.
 * Reserve a private slot, then move to its initially absent payload path.
 * Other Sweep workers cannot claim the same slot or overwrite its contents.
 */
export async function moveIntoTrashSlot(source: string, slot: string): Promise<void> {
  const parent = statSync(dirname(slot), { bigint: true });
  mkdirSync(slot, { mode: 0o700 });
  const owned = lstatSync(slot, { bigint: true });
  try {
    const currentParent = statSync(dirname(slot), { bigint: true });
    const currentSlot = lstatSync(slot, { bigint: true });
    if (
      currentParent.dev !== parent.dev ||
      currentParent.ino !== parent.ino ||
      currentSlot.dev !== owned.dev ||
      currentSlot.ino !== owned.ino ||
      !currentSlot.isDirectory() ||
      currentSlot.isSymbolicLink()
    ) {
      throw new Error("trash slot or its parent changed during reservation");
    }
    await rename(source, join(slot, "payload"));
  } catch (error) {
    try {
      const current = lstatSync(slot, { bigint: true });
      if (current.dev === owned.dev && current.ino === owned.ino && !current.isSymbolicLink()) {
        rmdirSync(slot); // Never recursively remove an occupied or replaced slot.
      }
    } catch {
      // Keep a changed/nonempty slot rather than risking deletion of its data.
    }
    throw error;
  }
}
