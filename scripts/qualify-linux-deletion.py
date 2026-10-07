#!/usr/bin/env python3
"""Qualify bounded native deep deletion using only owned Linux fixtures.

RLIMIT_NOFILE is applied only in the engine child. The timings are qualification
samples, not p99 benchmarks; /proc sampling can miss short resource peaks.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import tempfile
import threading
import time

REPO = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--depth", type=int, default=256)
parser.add_argument("--repeats", type=int, default=3)
parser.add_argument("--fds", type=int, default=32)
parser.add_argument("--output", required=True)
args = parser.parse_args()
if not Path("/proc/self/status").exists():
    parser.error("requires Linux /proc")
if not (1 <= args.depth <= 256 and 1 <= args.repeats <= 30 and 32 <= args.fds <= 64):
    parser.error("depth must be 1–256, repeats 1–30 and fds 32–64")
binary = REPO / "target/release/sweep-engine"
if not binary.exists():
    parser.error("build the release engine first")


def limit_fds():
    _, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    soft = args.fds if hard == resource.RLIM_INFINITY else min(args.fds, hard)
    resource.setrlimit(resource.RLIMIT_NOFILE, (soft, hard))


def apply(plan):
    started = time.monotonic()
    proc = subprocess.Popen([str(binary), "apply"], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            preexec_fn=limit_fds)
    peaks = {"fds": 0, "rssBytes": 0}
    stopped = threading.Event()

    def sample():
        while not stopped.is_set():
            try:
                peaks["fds"] = max(peaks["fds"], len(list(Path(f"/proc/{proc.pid}/fd").iterdir())))
                for line in Path(f"/proc/{proc.pid}/status").read_text().splitlines():
                    if line.startswith("VmRSS:"):
                        peaks["rssBytes"] = max(peaks["rssBytes"], int(line.split()[1]) * 1024)
            except OSError:
                pass
            stopped.wait(0.002)

    monitor = threading.Thread(target=sample, daemon=True)
    monitor.start()
    try:
        out, err = proc.communicate(json.dumps(plan).encode(), timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise RuntimeError("owned deletion exceeded 30-second qualification deadline")
    finally:
        stopped.set()
        monitor.join(timeout=1)
    if proc.returncode != 0:
        raise RuntimeError(f"native apply failed ({proc.returncode}): {err.decode(errors='replace')}")
    report = json.loads(out)
    if report["deletedCount"] != 1 or report["failedCount"] != 0:
        raise RuntimeError(f"native apply did not complete: {report}")
    return {"elapsedMs": (time.monotonic() - started) * 1000,
            "sampledPeakDescriptors": peaks["fds"],
            "sampledPeakRssBytes": peaks["rssBytes"],
            "deletedCount": report["deletedCount"], "failedCount": report["failedCount"]}


rows = []
with tempfile.TemporaryDirectory(prefix="sweep-deep-deletion-") as owned:
    for trial in range(args.repeats):
        root = Path(owned) / str(trial)
        artifact = root / "node_modules"
        artifact.mkdir(parents=True)
        sentinel = root / "unselected-sentinel"
        sentinel.write_text("keep")
        deep = artifact
        for _ in range(args.depth):
            (deep / "file").write_bytes(b"owned")
            (deep / "sibling").mkdir()
            deep = deep / "d"
            deep.mkdir()
        (deep / "file").write_bytes(b"owned")
        scanned = subprocess.run([str(binary), "scan", str(root)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 timeout=30, check=True)
        plan = json.loads(scanned.stdout)
        if len(plan["selectedCandidateIds"]) != 1:
            raise RuntimeError("fixture did not produce exactly one selected artifact")
        row = apply(plan)
        if artifact.exists() or sentinel.read_text() != "keep":
            raise RuntimeError("phantom removal or unselected sentinel changed")
        row["unselectedPreserved"] = True
        rows.append(row)

result = {"platform": os.uname().sysname,
          "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
          "depth": args.depth, "repeats": args.repeats, "fdSoftLimit": args.fds,
          "qualification": "Owned deep artifacts with a file and sibling at each level; actual low-FD native apply. Sampled resources and timings are evidence, not a hard RSS cap or p99 benchmark.",
          "samples": rows}
Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
