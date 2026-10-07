#!/usr/bin/env python3
"""Qualify lost result delivery and cooperative SIGINT on owned apply fixtures."""
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parent.parent
PREFIX = [str(Path(sys.argv[1]).resolve())] if len(sys.argv) > 1 else [shutil.which("node") or "node", str(REPO / "apps/cli/dist/sweep.js")]
COUNT = 40
if shutil.disk_usage(REPO).free < 128 * 1024 * 1024:
    raise SystemExit("Need at least 128 MiB free for the owned fixture")

results = []

def first_progress(proc):
    """Bound preparation wait and diagnostics before a first removal receipt."""
    deadline = time.monotonic() + 30
    buffered = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(proc.stderr, selectors.EVENT_READ)
        while time.monotonic() < deadline:
            if not selector.select(max(0, deadline - time.monotonic())):
                break
            chunk = os.read(proc.stderr.fileno(), 4096)
            if not chunk:
                return bytes(buffered)
            buffered.extend(chunk)
            if len(buffered) > 65536:
                raise RuntimeError("Preparation diagnostics exceeded 64 KiB")
            while b"\n" in buffered:
                line, _, tail = buffered.partition(b"\n")
                buffered = bytearray(tail)
                if line.strip():
                    return bytes(line) + b"\n"
    raise RuntimeError("No completed-removal progress within 30 seconds")

with tempfile.TemporaryDirectory(prefix="sweep-apply-pipe-", dir=REPO / "target") as owned:
    owned = Path(owned)
    for engine, scenario in [(engine, scenario) for engine in ["js", "rust"] for scenario in ["lost-receipt", "sigint"]]:
        tree = owned / f"{engine}-{scenario}"
        tree.mkdir()
        (tree / ".sweeprc").write_text("{}\n")
        (tree / "keep").write_text("unselected")
        for i in range(COUNT):
            artifact = tree / str(i) / "target"
            artifact.mkdir(parents=True)
            for j in range(200):
                (artifact / str(j)).write_bytes(b"x")
        config = owned / "config" / f"{engine}-{scenario}"
        env = {**os.environ, "SWEEP_CONFIG_DIR": str(config), "SWEEP_ENGINE_PATH": str(REPO / "target/release/sweep-engine")}
        scan = subprocess.run(PREFIX + ["scan", str(tree), "--json", "--engine", engine], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=30)
        if scan.returncode != 0:
            raise RuntimeError(f"Fixture scan failed: {scan.stderr.decode(errors='replace')}")
        plan = owned / f"{engine}.json"
        plan.write_bytes(scan.stdout)
        proc = subprocess.Popen(PREFIX + ["apply", "--plan", str(plan), "--yes", "--engine", engine], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        try:
            line = first_progress(proc)
            if not line.startswith(b"sweep: deleting [1/"):
                out, err = proc.communicate(timeout=30)
                raise RuntimeError(f"Expected first completed deletion progress: {line!r}; exit={proc.returncode}; stdout={out!r}; stderr={err!r}")
            if scenario == "sigint":
                proc.send_signal(signal.SIGINT)
            else:
                proc.stdout.close()
            code = proc.wait(timeout=30)
            error = proc.stderr.read().decode(errors="replace")
            remaining = sum((tree / str(i) / "target").exists() for i in range(COUNT))
            if (scenario == "sigint" and (remaining == 0 or code != 1)) or (scenario == "lost-receipt" and code != 4):
                raise RuntimeError(f"{scenario}: remaining={remaining}, exit={code}, stderr={error}")
            if (tree / "keep").read_text() != "unselected":
                raise RuntimeError("Unselected sentinel was modified")
            history_files = list(config.rglob("history.jsonl"))
            if len(history_files) != 1:
                raise RuntimeError("Interrupted apply did not persist its history")
            history = json.loads(history_files[0].read_text().splitlines()[-1])
            if (scenario == "sigint" and not history["interrupted"]) or history["deleted"] != COUNT - remaining:
                raise RuntimeError("Interrupted history disagrees with the owned tree")
            result = {"engine": engine, "scenario": scenario, "candidates": COUNT, "deleted": COUNT - remaining, "remaining": remaining, "exitCode": code, "historyMatchesDisk": True}
            results.append(result)
            print(json.dumps(result), flush=True)
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
print("ok: lost receipts fail, SIGINT stops scheduling, and history matches owned trees")
