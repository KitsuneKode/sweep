import { makeProgram } from "./cli.js";
import { handleFatalError } from "./errors.js";

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

if (import.meta.main) {
  installGlobalErrorHandlers();
  makeProgram().parse();
}
