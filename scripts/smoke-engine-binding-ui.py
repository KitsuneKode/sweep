#!/usr/bin/env python3
"""Linux PTY: the CLI bundle and the UI bundle share one bound native engine.

The packaged CLI (`dist/sweep.js`) and the terminal UI (`dist/sweep-ui.js`)
each bundle their own copy of the core package, and both run in one Bun
process. The engine bound by one must be the engine the other runs.

The engine at SWEEP_ENGINE_PATH is a `#!` wrapper (development opt-in) that
logs each call and execs the real release engine. At a chosen moment it
renames a second wrapper over its own path, so the file changes after it was
bound without any timing in the test.

  --mode ui-binds   the UI bundle's scan binds; after the swap, apply through
                    the CLI bundle must refuse and remove nothing.
  --mode cli-binds  the CLI bundle's --engine auto probe binds; after the
                    swap, the UI bundle's scan must refuse to run the new file.
"""
import argparse
import fcntl
import json
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
REAL_ENGINE = REPO / "target/release/sweep-engine"
parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--mode", choices=["ui-binds", "cli-binds"], required=True)
options = parser.parse_args()
bun = shutil.which("bun")
if not bun:
    raise SystemExit("bun is required")
if not REAL_ENGINE.is_file():
    raise SystemExit("target/release/sweep-engine is required (bun run engine:build)")
# The swap happens on the call that binds in each mode.
swap_on = "scan" if options.mode == "ui-binds" else "--version"


def wrapper(log: Path, swap_from: Path | None, swap_to: Path | None) -> str:
    swap = ""
    if swap_from and swap_to:
        swap = f'if [ "$1" = "{swap_on}" ] && [ -e "{swap_from}" ]; then mv -f "{swap_from}" "{swap_to}"; fi\n'
    return f'#!/bin/sh\necho "$1" >> "{log}"\n{swap}exec "{REAL_ENGINE}" "$@"\n'


with tempfile.TemporaryDirectory(prefix="sweep-engine-binding-", dir=REPO / "target") as owned:
    root = Path(owned)
    os.chmod(root, 0o700)
    project = root / "project"
    for name in ["alpha", "bravo"]:
        artifact = project / name / "node_modules"
        artifact.mkdir(parents=True)
        (artifact / "file").write_bytes(b"keep")
    (project / ".sweeprc").write_text("{}\n")
    bins = root / "bin"
    bins.mkdir(mode=0o700)
    engine = bins / "sweep-engine"
    staged = bins / "replacement"
    checked_log = root / "checked.log"
    replacement_log = root / "replacement.log"
    staged.write_text(wrapper(replacement_log, None, None))
    engine.write_text(wrapper(checked_log, staged, engine))
    os.chmod(staged, 0o700)
    os.chmod(engine, 0o700)

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 160, 0, 0))
    env = {**os.environ, "TERM": "xterm-256color", "XDG_CONFIG_HOME": str(root / "config"),
           "SWEEP_CONFIG_DIR": str(root / "config"), "SWEEP_ENGINE_PATH": str(engine),
           "SWEEP_ALLOW_SCRIPT_ENGINE": "1"}
    engine_flag = "rust" if options.mode == "ui-binds" else "auto"
    proc = subprocess.Popen([bun, "apps/cli/dist/sweep.js", "ui", str(project), "--view", "full", "--engine", engine_flag],
                            cwd=REPO, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def pump():
        if select.select([master], [], [], 0.05)[0]:
            output.extend(os.read(master, 65536))
            if len(output) > 4 * 1024 * 1024:
                raise RuntimeError("PTY output ceiling exceeded")

    def text():
        return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace"))

    def calls(log: Path) -> list[str]:
        return log.read_text().split() if log.exists() else []

    def wait_until(predicate, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            if proc.poll() is not None:
                raise RuntimeError(f"UI exited early: {proc.returncode}; {text()[-3000:]!r}")
            pump()
        raise RuntimeError(f"PTY condition timed out; calls {calls(checked_log)} / {calls(replacement_log)}; "
                           f"recent output: {text()[-4000:]!r}")

    def journal_records():
        journals = list((root / "config/journals").glob("*.jsonl"))
        if len(journals) != 1:
            return []
        return [json.loads(line) for line in journals[0].read_text().splitlines()]

    try:
        if options.mode == "ui-binds":
            # The UI bundle's native scan binds the checked wrapper, which swaps itself on that call.
            wait_until(lambda: "scan complete:" in text() and "node_modules" in text())
            if staged.exists() or "scan" not in calls(checked_log):
                raise RuntimeError("the checked engine did not run the scan and swap itself out")
            os.write(master, b"s")
            wait_until(lambda: "Review queue (2)" in text())
            os.write(master, b"x")
            wait_until(lambda: "Permanently delete" in text())
            os.write(master, b"y")
            # A refused apply still commits its journal, with every entry unattempted.
            wait_until(lambda: (records := journal_records()) != [] and records[-1]["type"] == "complete")
            records = journal_records()
            outcomes = [r for r in records if r["type"] == "outcome"]
            if not outcomes or any(r["status"] != "unattempted" for r in outcomes):
                raise RuntimeError(f"apply was not refused before it started: {outcomes}")
            if "apply" in calls(replacement_log) or "apply" in calls(checked_log):
                raise RuntimeError(f"an engine received apply: {calls(checked_log)} / {calls(replacement_log)}")
            if not all((project / name / "node_modules/file").exists() for name in ["alpha", "bravo"]):
                raise RuntimeError("something was removed")
            print("ok: UI bundle bound the engine; CLI bundle apply refused the swapped file; nothing removed; journal unattempted")
        else:
            # The CLI bundle's auto probe binds the checked wrapper, which swaps itself on --version.
            wait_until(lambda: "--version" in calls(checked_log) and not staged.exists())
            # The UI bundle's scan resolves the same path, sees a different file, and refuses.
            wait_until(lambda: "changed after sweep checked it" in re.sub(r"\s+", " ", text())
                       or "scan" in calls(replacement_log) or "scan complete:" in text())
            if "scan" in calls(replacement_log) or "scan complete:" in text():
                raise RuntimeError(f"the UI bundle scanned with the swapped engine: {calls(replacement_log)}")
            print("ok: CLI bundle bound the engine; UI bundle scan refused the swapped file")
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
        os.close(master)
