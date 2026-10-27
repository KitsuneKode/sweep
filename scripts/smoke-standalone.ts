import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

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
  for (const args of [["--ui-probe"], ["--version"]]) {
    const probe = Bun.spawn([executable, ...args], {
      cwd: owned,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, error] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    if (code !== 0 || !out.trim())
      throw new Error(`Standalone ${args[0]} failed (${code}): ${error}`);
    if (args[0] === "--ui-probe" && !out.includes("embedded sweep-ui module loaded")) {
      throw new Error("Standalone UI probe did not load the embedded module");
    }
  }
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

  // The probe proves the UI module loaded; only a real session proves the
  // native renderer did. Run `sweep ui` under a pseudo-terminal until the
  // projects view answers, then quit. (Windows has no `script` to lend a PTY.)
  if (process.platform !== "win32") {
    const command = `${JSON.stringify(executable)} ui --dry-run ${JSON.stringify(owned)}`;
    const ptyArgs =
      process.platform === "darwin"
        ? ["script", "-q", "/dev/null", "sh", "-c", command]
        : ["script", "-qec", command, "/dev/null"];
    const session = Bun.spawn(ptyArgs, {
      cwd: owned,
      env: { ...env, PATH: "/usr/bin:/bin", TERM: "xterm-256color", COLUMNS: "100", LINES: "30" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let screen = "";
    const reader = (async () => {
      for await (const chunk of session.stdout) screen += new TextDecoder().decode(chunk);
    })();
    const deadline = Date.now() + 15_000;
    while (
      !/you can reclaim|Nothing to clean|scan complete:/.test(screen) &&
      Date.now() < deadline
    ) {
      if (/Failed to initialize OpenTUI|requires @opentui/.test(screen)) break;
      await Bun.sleep(100);
    }
    const ready = /you can reclaim|Nothing to clean|scan complete:/.test(screen);
    session.stdin.write("q");
    await session.stdin.flush();
    const exited = await Promise.race([session.exited, Bun.sleep(5_000).then(() => "timeout")]);
    if (exited === "timeout") session.kill("SIGKILL");
    await reader.catch(() => {});
    if (!ready) {
      const visible = stripVTControlCharacters(screen).slice(-800);
      throw new Error(`Standalone UI did not render: ${visible}`);
    }
    console.log("ok: standalone terminal UI rendered and quit through a PTY");
  }
} finally {
  rmSync(owned, { recursive: true, force: true });
}
