import { rmSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

/** Only for directories created by the calling qualification script. */
export async function removeOwnedTempDirectory(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 10 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code ?? "")) throw error;
      // Windows can briefly retain a handle after the executable exits.
      // Retry explicitly: Bun 1.4.2 does not honor rmSync's maxRetries here.
      await setTimeout(100 * (attempt + 1));
    }
  }
}
