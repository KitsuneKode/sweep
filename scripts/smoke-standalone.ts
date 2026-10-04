import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executable = resolve(process.argv[2] ?? "sweep");
const owned = mkdtempSync(join(tmpdir(), "sweep-standalone-smoke-"));
try {
  mkdirSync(join(owned, "node_modules"));
  writeFileSync(join(owned, "node_modules/file"), "embedded engine");
  const env = { ...process.env, PATH: "", SWEEP_ENGINE_PATH: "" };
  // Strip Windows' case-insensitive PATH aliases as well.
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path") delete env[key as keyof typeof env];
  env.PATH = "";
  const proc = Bun.spawn([executable, "scan", owned, "--engine", "rust", "--json"], {
    cwd: owned,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Standalone native scan failed (${code}): ${error}`);
  const plan = JSON.parse(output);
  if (plan.candidates.length !== 1 || plan.summary.estimatedTotalBytes !== 15)
    throw new Error(`Unexpected standalone scan: ${output}`);
  if (!plan.targetIdentity || !plan.candidates[0]?.identity)
    throw new Error("Standalone scan omitted approval identity snapshots");
  console.log("ok: embedded Rust scan without Node, Bun or external engine on PATH");
} finally {
  rmSync(owned, { recursive: true, force: true });
}
