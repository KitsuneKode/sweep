import { abortActiveApply, isApplyActive } from "./apply-lifecycle.js";
import { makeProgram } from "./cli.js";
import { handleFatalError } from "./errors.js";

function installGlobalErrorHandlers(): void {
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      // `sweep scan | head -1` closing the pipe is a clean exit for
      // read-only output - but mid-apply exit(0) would claim a destructive
      // operation finished when it did not. Abort it instead: the report
      // cannot print anyway, but history writes and the exit stays honest.
      if (isApplyActive()) {
        abortActiveApply();
        return;
      }
      process.exit(0);
    }
  });

  process.stderr.on("error", () => {
    // A dead diagnostic sink has nowhere left to report - swallowing keeps
    // an EPIPE'd stderr from surfacing as uncaughtException mid-operation.
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
