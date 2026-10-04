/**
 * Entrypoint for standalone compiled binaries (`bun build --compile`).
 *
 * Unlike bin.ts - which loads the UI through runtime-resolved specifiers so
 * npm installs can fetch it separately - this entry imports the UI module
 * statically and registers it before the CLI boots. The static graph is what
 * makes Bun embed the UI code and OpenTUI's native assets into the executable.
 */
import { makeProgram } from "./cli.js";
import { installGlobalErrorHandlers } from "./global-errors.js";
import { registerUiModule } from "./handlers/ui.js";
import { registerEmbeddedEngine } from "@kitsunekode/sweep-core/rust-engine";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The UI package's entry is a .tsx module and the CLI compiles without JSX
// support - that mismatch is why the normal path loads it dynamically.
// Here the un-typed static import is the whole point: Bun embeds the UI
// code and OpenTUI native assets into the compiled executable.
// @ts-expect-error -- .tsx entry resolved by Bun's bundler, not tsc
import * as sweepUi from "@kitsunekode/sweep-ui";

registerUiModule(sweepUi);

// Build-time probe: proves the static UI graph (including OpenTUI native
// dlopen at import time) survived compilation. Used by cli-binaries CI.
if (process.argv.includes("--ui-probe")) {
  console.log("ok: embedded sweep-ui module loaded");
  process.exit(0);
}

if (import.meta.main) {
  installGlobalErrorHandlers();
  let nativePath: string | undefined;
  registerEmbeddedEngine(() => {
    if (nativePath) return nativePath;
    const name = `sweep-engine${process.platform === "win32" ? ".exe" : ""}`;
    // Bun 1.4.2 exposes this individual --asset at its basename in $bunfs.
    const source = join(import.meta.dir, name);
    const bytes = readFileSync(source);
    if (bytes.length === 0 || bytes.length > 16 * 1024 * 1024) {
      throw new Error("Invalid embedded Rust engine asset");
    }
    const owned = mkdtempSync(join(tmpdir(), "sweep-native-"));
    try {
      chmodSync(owned, 0o700);
      const destination = join(owned, name);
      writeFileSync(destination, bytes, { flag: "wx", mode: 0o700 });
      nativePath = destination;
    } catch (error) {
      rmSync(owned, { recursive: true, force: true });
      throw error;
    }
    process.once("exit", () => {
      try {
        rmSync(owned, { recursive: true, force: true });
      } catch {
        /* OS may still hold a Windows executable. */
      }
    });
    return nativePath;
  });
  makeProgram().parse();
}
