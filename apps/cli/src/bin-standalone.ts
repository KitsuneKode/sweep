/**
 * Entrypoint for standalone compiled binaries (`bun build --compile`).
 *
 * Unlike bin.ts — which loads the UI through runtime-resolved specifiers so
 * npm installs can fetch it separately — this entry imports the UI module
 * statically and registers it before the CLI boots. The static graph is what
 * makes Bun embed the UI code and OpenTUI's native assets into the executable.
 */
import { makeProgram } from "./cli.js";
import { handleFatalError } from "./errors.js";
import { registerUiModule } from "./handlers/ui.js";
// The UI package's entry is a .tsx module and the CLI compiles without JSX
// support — that mismatch is why the normal path loads it dynamically.
// Here the un-typed static import is the whole point: Bun embeds the UI
// code and OpenTUI native assets into the compiled executable.
// @ts-expect-error -- .tsx entry resolved by Bun's bundler, not tsc
import * as sweepUi from "@kitsunekode/sweep-ui";

registerUiModule(sweepUi);

function installGlobalErrorHandlers(): void {
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      process.exit(0);
    }
  });

  process.on("unhandledRejection", (reason) => {
    handleFatalError(reason);
  });

  process.on("uncaughtException", (err) => {
    handleFatalError(err);
  });
}

// Build-time probe: proves the static UI graph (including OpenTUI native
// dlopen at import time) survived compilation. Used by cli-binaries CI.
if (process.argv.includes("--ui-probe")) {
  console.log("ok: embedded sweep-ui module loaded");
  process.exit(0);
}

if (import.meta.main) {
  installGlobalErrorHandlers();
  makeProgram().parse();
}
