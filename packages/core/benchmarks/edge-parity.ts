/** Diagnostic parity probes; records known gaps rather than asserting parity. */
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SELECTION_POLICY } from "@kitsunekode/sweep-protocol";
import { DEFAULT_CONFIG } from "../src/config.js";
import { scanToPlan } from "../src/engine.js";
import { scanToPlanViaRust } from "../src/rust-engine.js";
const root = mkdtempSync(join(tmpdir(), "sweep-extra-edge-"));
process.env.SWEEP_ENGINE_PATH ??= join(import.meta.dir, "../../../target/release/sweep-engine");
try {
  const a = join(root, "a/node_modules"),
    b = join(root, "b/node_modules");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, "shared"), Buffer.alloc(1000));
  linkSync(join(a, "shared"), join(b, "shared"));
  const js = (await scanToPlan(root, DEFAULT_CONFIG, { onEntry: () => {}, onEntrySized: () => {} }))
    .plan;
  const rust = await scanToPlanViaRust(root, {
    config: DEFAULT_CONFIG,
    selectionPolicy: DEFAULT_SELECTION_POLICY,
    onEntry: () => {},
    onEntrySized: () => {},
  });
  console.log(
    JSON.stringify({
      case: "cross-artifact-hardlink",
      jsBytes: js.summary.estimatedTotalBytes,
      rustBytes: rust.summary.estimatedTotalBytes,
    }),
  );
  mkdirSync(join(root, "🦊"));
  const config = { ...DEFAULT_CONFIG, patterns: ["?"] };
  const j = (await scanToPlan(root, config, { exact: true })).plan;
  const r = await scanToPlanViaRust(root, {
    config,
    exact: true,
    selectionPolicy: DEFAULT_SELECTION_POLICY,
  });
  console.log(
    JSON.stringify({
      case: "unicode-question",
      jsNames: j.candidates.map((c) => c.name).sort(),
      rustNames: r.candidates.map((c) => c.name).sort(),
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
