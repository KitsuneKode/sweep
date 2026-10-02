#!/usr/bin/env python3
"""Alternate same-source standalone builds; measure --version process startup."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("--bytecode", required=True)
parser.add_argument("--plain", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
paths = {"bytecode": Path(args.bytecode).resolve(), "plain": Path(args.plain).resolve()}
samples = {name: [] for name in paths}
versions = set()
for round_number in range(33):
    order = list(paths) if round_number % 2 == 0 else list(reversed(paths))
    for name in order:
        start = time.perf_counter()
        proc = subprocess.run([str(paths[name]), "--version"], check=True, capture_output=True, timeout=10)
        elapsed = (time.perf_counter() - start) * 1000
        versions.add(proc.stdout.decode().strip())
        if round_number >= 3:
            samples[name].append(elapsed)
if len(versions) != 1:
    raise RuntimeError("compared binaries have different versions")
result = {"command": "--version", "version": versions.pop(), "samples": 30, "warmups": 3,
          "notes": "Alternating process launches, warm filesystem cache, same source. Includes static UI import; excludes native extraction, scanning and TTY rendering. Exploratory median/max, not qualified p99.",
          "builds": {name: {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                            "medianMs": statistics.median(samples[name]), "maxMs": max(samples[name]), "samplesMs": samples[name]}
                     for name, path in paths.items()}}
Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({name: row["medianMs"] for name, row in result["builds"].items()}))
