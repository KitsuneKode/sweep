#!/usr/bin/env python3
"""Qualify interrupted apply on owned fixtures when its progress consumer closes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parent.parent
PREFIX = [str(Path(sys.argv[1]).resolve())] if len(sys.argv) > 1 else [shutil.which("bun") or "bun", str(REPO / "apps/cli/dist/sweep.js")]
COUNT = 40
if shutil.disk_usage(REPO).free < 128 * 1024 * 1024:
    raise SystemExit("Need at least 128 MiB free for the owned fixture")

results = []
with tempfile.TemporaryDirectory(prefix="sweep-apply-pipe-", dir=REPO / "target") as owned:
    owned = Path(owned)
    for engine in ["js", "rust"]:
        tree = owned / engine
        tree.mkdir()
        (tree / ".sweeprc").write_text("{}\n")
        for i in range(COUNT):
            artifact = tree / str(i) / "target"
            artifact.mkdir(parents=True)
            for j in range(200):
                (artifact / str(j)).write_bytes(b"x")
        config = owned / "config" / engine
        env = {**os.environ, "SWEEP_CONFIG_DIR": str(config)}
        scan = subprocess.run(PREFIX + ["scan", str(tree), "--json", "--engine", engine], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=30)
        if scan.returncode != 0:
            raise RuntimeError(f"Fixture scan failed: {scan.stderr.decode(errors='replace')}")
        plan = owned / f"{engine}.json"
        plan.write_bytes(scan.stdout)
        proc = subprocess.Popen(PREFIX + ["apply", "--plan", str(plan), "--yes", "--engine", engine], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        try:
            line = proc.stdout.readline()
            if not line.startswith(b"sweep: deleting [1/"):
                raise RuntimeError(f"Expected first completed deletion progress: {line!r}")
            proc.stdout.close()
            code = proc.wait(timeout=30)
            error = proc.stderr.read().decode(errors="replace")
            remaining = sum((tree / str(i) / "target").exists() for i in range(COUNT))
            if remaining == 0 or code == 0:
                raise RuntimeError(f"Broken pipe did not interrupt apply: remaining={remaining}, exit={code}, stderr={error}")
            history_files = list(config.rglob("history.jsonl"))
            if len(history_files) != 1:
                raise RuntimeError("Interrupted apply did not persist its history")
            history = json.loads(history_files[0].read_text().splitlines()[-1])
            if not history["interrupted"] or history["deleted"] != COUNT - remaining:
                raise RuntimeError("Interrupted history disagrees with the owned tree")
            result = {"engine": engine, "candidates": COUNT, "deleted": COUNT - remaining, "remaining": remaining, "exitCode": code, "historyMatchesDisk": True}
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
print("ok: broken apply pipes stopped scheduling and retained accurate history")
