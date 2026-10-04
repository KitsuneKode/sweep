/** Install actual local CLI/native tarballs into an owned directory.
 * Offline by default; --online downloads public dependencies on fresh CI runners.
 * Headless package proof; excludes OpenTUI peer installation and real terminals.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const owned = mkdtempSync(join(tmpdir(), "sweep-installed-smoke-"));
const offline = !process.argv.includes("--online");
let nativeManifest: string | undefined;
let previousManifest: Buffer | undefined;
async function run(args: string[], cwd = repo, env = process.env): Promise<string> {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${args[0]} ${args[1]} failed (${code}): ${err.slice(-4000)}`);
  return out;
}
function packedName(output: string): string {
  const start = output.search(/^\s*\[/m);
  const files = JSON.parse(start >= 0 ? output.slice(start) : output) as Array<{
    filename: string;
  }>;
  if (files.length !== 1 || !files[0]?.filename)
    throw new Error("pack did not identify one tarball");
  return join(owned, files[0].filename);
}
try {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "64" : process.arch;
  const id = `${platform}-${arch}`;
  nativeManifest = join(repo, "native-packages", id, "package.json");
  previousManifest = readFileSync(nativeManifest);
  await run(["bun", "run", "packages/engine-native/scripts/pack.ts", "--platform", id]);
  const native = packedName(
    await run([
      "npm",
      "pack",
      `./native-packages/${id}`,
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      owned,
    ]),
  );
  const cli = packedName(
    await run(["npm", "pack", "-w", "@kitsunekode/sweep", "--json", "--pack-destination", owned]),
  );
  writeFileSync(join(owned, "package.json"), '{"private":true}\n');
  await run(
    [
      "npm",
      "install",
      ...(offline ? ["--offline"] : []),
      "--ignore-scripts",
      "--omit=dev",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      cli,
      native,
    ],
    owned,
  );
  const entry = join(owned, "node_modules/@kitsunekode/sweep/dist/sweep.js");
  const env = { ...process.env, XDG_CONFIG_HOME: join(owned, "config"), SWEEP_ENGINE_PATH: "" };
  const outcomes = [];
  for (const engine of ["js", "rust"]) {
    const root = join(owned, engine);
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, ".sweeprc"), "{}\n");
    writeFileSync(join(root, "node_modules/owned"), "owned");
    const planText = await run(
      ["node", entry, "scan", root, "--engine", engine, "--json"],
      root,
      env,
    );
    const plan = JSON.parse(planText);
    if (plan.candidates.length !== 1 || !plan.targetIdentity || !plan.candidates[0].identity)
      throw new Error("installed scan missing candidate/snapshots");
    const saved = join(owned, `${engine}-plan.json`);
    writeFileSync(saved, planText);
    const report = JSON.parse(
      await run(
        ["node", entry, "apply", "--plan", saved, "--engine", engine, "--yes", "--json"],
        root,
        env,
      ),
    );
    if (report.deletedCount !== 1 || report.failedCount !== 0)
      throw new Error("installed apply failed");
    let removed = false;
    try {
      lstatSync(join(root, "node_modules"));
    } catch (error) {
      removed = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    if (!removed) throw new Error("installed apply reported a phantom removal");
    outcomes.push({ engine, deletedCount: report.deletedCount, snapshotsPreserved: true });
  }
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        installation: `Actual local npm CLI/native tarballs, ${offline ? "offline cache" : "public dependency downloads"}, no scripts, native package resolved without SWEEP_ENGINE_PATH`,
        outcomes,
      },
      null,
      2,
    ),
  );
} finally {
  if (nativeManifest && previousManifest) writeFileSync(nativeManifest, previousManifest);
  rmSync(owned, { recursive: true, force: true });
}
