import { makeProgram } from "./cli.js";
import { installGlobalErrorHandlers } from "./global-errors.js";

if (import.meta.main) {
  installGlobalErrorHandlers();
  makeProgram().parse();
}
