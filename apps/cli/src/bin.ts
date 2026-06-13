import { makeProgram } from "./cli.js";

if (import.meta.main) {
  makeProgram().parse();
}
