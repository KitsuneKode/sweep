#!/usr/bin/env python3
"""Linux PTY: inspect -> confirm one artifact; never touch an existing project."""
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

REPO = Path(__file__).resolve().parent.parent
bun = shutil.which("bun")
if not bun:
    raise SystemExit("bun is required")
with tempfile.TemporaryDirectory(prefix="sweep-focused-pty-", dir=REPO / "target") as owned:
    root = Path(owned)
    for name, contents in [("alpha", b"a"), ("bravo", b"bb")]:
        artifact = root / name / "node_modules"
        artifact.mkdir(parents=True)
        (artifact / "file").write_bytes(contents)
    (root / ".sweeprc").write_text("{}\n")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
    env = {**os.environ, "TERM": "xterm-256color", "XDG_CONFIG_HOME": str(root / "config"), "SWEEP_CONFIG_DIR": str(root / "config"),
           "SWEEP_ENGINE_PATH": str(REPO / "target/release/sweep-engine")}
    proc = subprocess.Popen([bun, "apps/cli/dist/sweep.js", "ui", str(root), "--engine", "rust"],
                            cwd=REPO, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def wait_until(predicate, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            if proc.poll() is not None:
                raise RuntimeError(f"UI exited early: {proc.returncode}")
            if select.select([master], [], [], 0.05)[0]:
                output.extend(os.read(master, 65536))
                if len(output) > 1024 * 1024:
                    raise RuntimeError("PTY output ceiling exceeded")
        raise RuntimeError(f"PTY condition timed out; recent output: {text()[-6000:]!r}")

    def text():
        return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace"))

    try:
        wait_until(lambda: "scan complete:" in text() and "node_modules" in text())
        output.clear()
        os.write(master, b"i")
        # Background rows can repaint in the same frame. Pin the inspector's
        # labeled path, never whichever artifact name appears first anywhere.
        inspected_path = lambda: re.search(r"\bpath\s+(alpha|bravo)/node_modules\b", text())
        wait_until(lambda: "artifact" in text() and inspected_path() is not None)
        inspected = inspected_path()
        if inspected is None:
            raise RuntimeError("could not identify inspected artifact")
        viewed = inspected.group(1)
        output.clear()
        os.write(master, b"x")
        wait_until(lambda: "Permanently delete" in text())
        wait_until(lambda: re.search(rf"·\s*{viewed}/node_modules\b", text()) is not None)
        if not all((root / name / "node_modules").exists() for name in ["alpha", "bravo"]):
            raise RuntimeError("removal occurred before confirmation")
        os.write(master, b"y")
        wait_until(lambda: not (root / viewed / "node_modules").exists())
        other = "bravo" if viewed == "alpha" else "alpha"
        if not (root / other / "node_modules/file").exists():
            raise RuntimeError("scoped apply deleted the other queued artifact")
        wait_until(lambda: "1 deleted" in text() and "1 still queued" in text() and "estimated bytes removed" in text())
        os.write(master, b"q")
        deadline = time.monotonic() + 5
        while proc.poll() is None:
            if time.monotonic() >= deadline:
                raise RuntimeError("UI did not exit after its apply receipt")
            if select.select([master], [], [], 0.05)[0]:
                try:
                    output.extend(os.read(master, 65536))
                    if len(output) > 1024 * 1024:
                        raise RuntimeError("PTY output ceiling exceeded")
                except OSError:
                    break
        proc.wait(timeout=1)
        while select.select([master], [], [], 0.05)[0]:
            try:
                output.extend(os.read(master, 65536))
                if len(output) > 1024 * 1024:
                    raise RuntimeError("PTY output ceiling exceeded")
            except OSError:
                break
        if proc.returncode != 0:
            raise RuntimeError(f"completed UI apply exited {proc.returncode}, expected success")
        if "Aborted." in text():
            raise RuntimeError("completed UI apply was reported as aborted")
        if not re.search(r"1 deleted.*0 moved to trash.*0 failed.*0 unattempted", text()):
            raise RuntimeError("completed UI session summary was not delivered")
        print(f"ok: inspected {viewed}, confirmed only that artifact, preserved {other}")
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
        os.close(master)
