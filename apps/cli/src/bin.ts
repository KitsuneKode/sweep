import { makeProgram } from "./cli.js";
import { handleFatalError } from "./errors.js";

function installGlobalErrorHandlers(): void {
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
