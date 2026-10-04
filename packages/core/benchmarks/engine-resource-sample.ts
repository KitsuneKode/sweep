/** Fresh-process resource probe used by engine-comparison.ts. */
import { DEFAULT_SELECTION_POLICY } from "@kitsunekode/sweep-protocol";
import { DEFAULT_CONFIG } from "../src/config.js";
import { scanToPlan } from "../src/engine.js";
import { scanToPlanViaRust } from "../src/rust-engine.js";

const [engine, path, exact, binary, limitsJson, repeatArg] = process.argv.slice(2);
if (!path || !binary || (engine !== "js" && engine !== "rust"))
  throw new Error("Expected engine, fixture path, exact flag and binary path");
process.env.SWEEP_ENGINE_PATH = binary;
const options = {
  exact: exact === "true",
  selectionPolicy: DEFAULT_SELECTION_POLICY,
  onEntry: () => {},
  onEntrySized: () => {},
  ...(limitsJson ? { limits: JSON.parse(limitsJson) } : {}),
};
const repeats = Number(repeatArg ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100)
  throw new Error("repeat must be 1–100");
for (let i = 0; i < repeats; i++) {
  const started = performance.now();
  const plan =
    engine === "js"
      ? (await scanToPlan(path, DEFAULT_CONFIG, options)).plan
      : await scanToPlanViaRust(path, { config: DEFAULT_CONFIG, ...options });
  process.stdout.write(
    `${JSON.stringify({ ...plan.summary, unknownSizeCount: plan.candidates.filter((candidate) => candidate.bytesKnown === false).length, elapsedMs: performance.now() - started, memory: process.memoryUsage() })}\n`,
  );
}
