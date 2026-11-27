import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { buildStandaloneExecutable } from "./build-standalone.js";

/** Runs argv under a 100x30 pty until `ready_pattern` matches, sends `q`, exits 0 when matched. */
const PTY_DRIVER = String.raw`
import fcntl, os, pty, re, select, struct, sys, termios, time
ready = re.compile(sys.argv[1].encode("utf-8"))
argv = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    os.execv(argv[0], argv)
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

const BOUNDARY_SENTINEL = "SWEEP_STANDALONE_OUTER_BOUNDARY_SENTINEL";

/**
 * Compile a disposable standalone probe through the exact same
 * `buildStandaloneExecutable()` pipeline and verify OpenTUI's outer
 * ErrorBoundary renders a thrown render error instead of crashing on
 * undefined `jsxDEV` and leaving the screen blank.
 */
async function verifyStandaloneOuterErrorBoundary(
  owned: string,
  env: Record<string, string | undefined>,
  python: string | null,
): Promise<void> {
  const probeDir = join(owned, "boundary-probe");
  mkdirSync(probeDir, { recursive: true });
  const probeSrc = join(probeDir, "probe.tsx");
  const probeBin = join(
    probeDir,
    process.platform === "win32" ? "boundary-probe.exe" : "boundary-probe",
  );
  // Resolve from packages/ui so React and @opentui/{core,react} match the app.
  const uiDir = resolve(import.meta.dir, "../packages/ui");
  const reactEntry = Bun.resolveSync("react", uiDir);
  const openTuiCoreEntry = Bun.resolveSync("@opentui/core", uiDir);
  const openTuiReactEntry = Bun.resolveSync("@opentui/react", uiDir);

  writeFileSync(
    probeSrc,
    `import React from ${JSON.stringify(reactEntry)};
import { createCliRenderer } from ${JSON.stringify(openTuiCoreEntry)};
import { createRoot } from ${JSON.stringify(openTuiReactEntry)};

function Explode(): React.ReactNode {
  throw new Error(${JSON.stringify(BOUNDARY_SENTINEL)});
}

if (process.argv.includes("--check-boundary")) {
  // Verify the compiled bundle does not leave undefined jsxDEV on the render path.
  const renderer = await createCliRenderer({ testing: true, exitOnCtrlC: false });
  const root = createRoot(renderer);
  root.render(React.createElement(Explode));
  await new Promise((r) => setTimeout(r, 150));
  root.unmount();
  renderer.destroy();
  console.log("ok: outer boundary mounted without jsxDEV crash");
  process.exit(0);
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
renderer.keyInput.on("keypress", (key) => {
  if (key.name === "q") {
    renderer.destroy();
    process.exit(0);
  }
});
createRoot(renderer).render(React.createElement(Explode));
`,
  );

  await buildStandaloneExecutable({
    entry: probeSrc,
    outfile: probeBin,
    bytecode: true,
  });

  if (process.platform !== "win32" && python) {
    const session = Bun.spawn([python, "-I", "-c", PTY_DRIVER, BOUNDARY_SENTINEL, probeBin], {
      cwd: probeDir,
      env: { ...env, TERM: "xterm-256color" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, screen, error] = await Promise.all([
      session.exited,
      new Response(session.stdout).text(),
      new Response(session.stderr).text(),
    ]);
    if (code !== 0) {
      const visible = stripVTControlCharacters(screen).slice(-800);
      throw new Error(
        `Standalone outer ErrorBoundary stayed blank or failed (${code}): ${visible}${error}`,
      );
    }
    console.log("ok: standalone OpenTUI outer ErrorBoundary rendered error through PTY");
  } else {
    const check = Bun.spawn([probeBin, "--check-boundary"], {
      cwd: probeDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      check.exited,
      new Response(check.stdout).text(),
      new Response(check.stderr).text(),
    ]);
    const visible = stripVTControlCharacters(out);
    if (
      code !== 0 ||
      !visible.includes(BOUNDARY_SENTINEL) ||
      !visible.includes("ok: outer boundary")
    ) {
      throw new Error(`Standalone outer ErrorBoundary probe failed (${code}): ${visible}${err}`);
    }
    console.log("ok: standalone OpenTUI outer ErrorBoundary verified without jsxDEV crash");
  }
}

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
      [
        python,
        "-I",
        "-c",
        PTY_DRIVER,
        "you can reclaim|Nothing to clean|scan complete:",
        executable,
        "ui",
        "--dry-run",
        owned,
      ],
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

  await verifyStandaloneOuterErrorBoundary(owned, env, python);
} finally {
  rmSync(owned, { recursive: true, force: true });
}
