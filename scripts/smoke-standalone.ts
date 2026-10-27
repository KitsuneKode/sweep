import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

/** Runs argv under a 100x30 pty until the UI answers, sends `q`, exits 0 when it rendered. */
const PTY_DRIVER = String.raw`
import fcntl, os, pty, re, select, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    os.execv(sys.argv[1], sys.argv[1:])
ready = re.compile(rb"you can reclaim|Nothing to clean|scan complete:")
failed = re.compile(rb"Failed to initialize OpenTUI|requires @opentui")
screen = b""
deadline = time.time() + 15
while time.time() < deadline and not ready.search(screen) and not failed.search(screen):
    if select.select([fd], [], [], 0.1)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        screen += chunk
ok = bool(ready.search(screen))
try:
    os.write(fd, b"q")
except OSError:
    pass
deadline = time.time() + 5
while not os.waitpid(pid, os.WNOHANG)[0]:
    if time.time() > deadline:
        os.kill(pid, 9)
        break
    if select.select([fd], [], [], 0.1)[0]:
        try:
            os.read(fd, 65536)
        except OSError:
            pass
sys.stdout.buffer.write(screen[-8000:])
sys.exit(0 if ok else 1)
`;

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
  // projects view answers, then quit. Python's pty works alike on Linux and
  // macOS, where BSD `script` refuses a piped stdin. (Windows has no pty.)
  const python = Bun.which("python3");
  if (process.platform !== "win32" && python) {
    const session = Bun.spawn(
      [python, "-I", "-c", PTY_DRIVER, executable, "ui", "--dry-run", owned],
      {
        cwd: owned,
        env: { ...env, TERM: "xterm-256color" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, screen, error] = await Promise.all([
      session.exited,
      new Response(session.stdout).text(),
      new Response(session.stderr).text(),
    ]);
    if (code !== 0) {
      const visible = stripVTControlCharacters(screen).slice(-800);
      throw new Error(`Standalone UI did not render (${code}): ${visible}${error}`);
    }
    console.log("ok: standalone terminal UI rendered and quit through a PTY");
  }
} finally {
  rmSync(owned, { recursive: true, force: true });
}
