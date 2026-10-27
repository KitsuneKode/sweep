#!/usr/bin/env python3
"""Linux PTY: interrupt an active owned removal and verify its journal and terminal receipt."""
import fcntl
import argparse
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
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--exit-signal", choices=["SIGHUP", "SIGTERM"], required=True)
options = parser.parse_args()
bun = shutil.which("bun")
if not bun:
    raise SystemExit("bun is required")
with tempfile.TemporaryDirectory(prefix="sweep-focused-pty-", dir=REPO / "target") as owned:
    root = Path(owned)
    for name, contents in [("alpha", b"a"), ("bravo", b"bb")]:
        artifact = root / name / "node_modules"
        artifact.mkdir(parents=True)
        (artifact / "file").write_bytes(contents)
        for index in range(50000):
            (artifact / f"entry-{index:05d}").write_bytes(contents)
    (root / ".sweeprc").write_text("{}\n")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
    env = {**os.environ, "TERM": "xterm-256color", "XDG_CONFIG_HOME": str(root / "config"), "SWEEP_CONFIG_DIR": str(root / "config"),
           "SWEEP_ENGINE_PATH": str(REPO / "target/release/sweep-engine")}
    proc = subprocess.Popen([bun, "apps/cli/dist/sweep.js", "ui", str(root), "--view", "full", "--engine", "rust"],
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
        os.write(master, b"s")
        wait_until(lambda: "Review queue (2)" in text())
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
        current = root / viewed / "node_modules"
        wait_until(lambda: not (current / "entry-00000").exists(), timeout=20)
        # The final unlink can race the signal. Both a committed successful
        # removal and a committed partial failure are honest outcomes.
        other = "bravo" if viewed == "alpha" else "alpha"
        signal_sent = time.monotonic()
        os.kill(proc.pid, getattr(signal, options.exit_signal))
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
        if proc.returncode not in (0, 4):
            raise RuntimeError(f"active removal exited {proc.returncode}; {text()[-2500:]}")
        if "Aborted." in text():
            raise RuntimeError("active removal lost its session receipt")
        if b"\x1b[?1049l" not in output:
            raise RuntimeError("alternate screen was not restored before exit")
        if not (root / other / "node_modules/file").exists():
            raise RuntimeError("cancellation touched the other queued artifact")
        import json
        journals = list((root / "config/journals").glob("*.jsonl"))
        if len(journals) != 1:
            raise RuntimeError(f"expected one journal, got {journals}")
        records = [json.loads(line) for line in journals[0].read_text().splitlines()]
        outcomes = [r for r in records if r["type"] == "outcome"]
        if records[-1]["type"] != "complete" or len(outcomes) != 1 or outcomes[0]["status"] not in ("failed", "deleted"):
            raise RuntimeError(f"active signal did not commit its trusted outcome: {records}")
        status = outcomes[0]["status"]
        candidates = [record for record in records if record["type"] == "candidate"]
        if len(candidates) != 1 or outcomes[0]["candidateId"] != candidates[0]["candidateId"]:
            raise RuntimeError("journal outcome does not match the scoped review")
        expected_exit = 4 if status == "failed" else 0
        if proc.returncode != expected_exit or current.exists() != (status == "failed"):
            raise RuntimeError(f"journal, disk and exit disagree: {status}, exit {proc.returncode}")
        deleted, failed = (0, 1) if status == "failed" else (1, 0)
        if not re.search(rf"{deleted} deleted.*0 moved to trash.*{failed} failed.*0 unattempted", text()):
            raise RuntimeError(f"active removal omitted its outcome counts: {text()[-2500:]}")
        print(f"ok: active {options.exit_signal}; {status}; other queue preserved; journal committed; exit {proc.returncode}; alternate screen restored; {time.monotonic()-signal_sent:.3f}s to settle")
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
        os.close(master)
