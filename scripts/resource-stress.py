#!/usr/bin/env python3
"""Owned Linux fixtures; bounded RSS monitor, low FDs, rescans and slow readers.

No removals outside this script's TemporaryDirectory and no registry calls.
This measures a process tree's sampled RSS, not a proof of constant memory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import tempfile
import threading
import time


REPO = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--files", type=int, default=20000)
parser.add_argument("--repeats", type=int, default=5)
parser.add_argument("--fds", type=int, default=64)
parser.add_argument("--rss-mb", type=int, default=512)
parser.add_argument("--fixture-parent", default=tempfile.gettempdir())
parser.add_argument("--output", required=True)
parser.add_argument("--sparse-gib", type=int, default=0)
parser.add_argument("--existing-tree", help="optional read-only scan; never modified or cleaned up")
args = parser.parse_args()
if not 0 <= args.sparse_gib <= 1024:
    parser.error("sparse-gib must be 0–1024")
if not (1 <= args.files <= 1000000 and 1 <= args.repeats <= 100 and 32 <= args.fds <= 1024 and 64 <= args.rss_mb <= 4096):
    parser.error("invalid file, repeat, descriptor or RSS bound")
if not Path("/proc/self/status").exists():
    parser.error("this resource probe requires Linux /proc")
BINARY = REPO / "target/release/sweep-engine"
if not BINARY.exists():
    parser.error("build the release engine first: bun run engine:build")
bun = shutil.which("bun")
if not bun:
    parser.error("bun is required")
capacity = os.statvfs(args.fixture_parent)
entries = args.files + 4096
if capacity.f_bavail * capacity.f_frsize < entries * 4096 + 512 * 1024 * 1024 or capacity.f_favail < entries + 10000:
    parser.error("insufficient free space/inodes for an owned fixture with reserve")


def descendants(pid):
    result = {pid}
    todo = [pid]
    while todo:
        current = todo.pop()
        try:
            # A runtime may spawn its child from a background thread. Checking
            # only the main thread's children can miss that child's RSS.
            children = []
            for task in Path(f"/proc/{current}/task").iterdir():
                try:
                    children.extend((task / "children").read_text().split())
                except OSError:
                    pass
        except OSError:
            continue
        for child in children:
            child = int(child)
            if child not in result:
                result.add(child)
                todo.append(child)
    return result


def process_resources(pids):
    total = 0
    threads = 0
    for pid in pids:
        try:
            for line in Path(f"/proc/{pid}/status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    total += int(line.split()[1]) * 1024
                elif line.startswith("Threads:"):
                    threads += int(line.split()[1])
        except OSError:
            pass
    return total, threads


def limit_fds():
    _, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    soft = args.fds if hard == resource.RLIM_INFINITY else min(args.fds, hard)
    resource.setrlimit(resource.RLIMIT_NOFILE, (soft, hard))


def run(name, command, request=None, expected=0, slow=False, allow_partial=False):
    started = time.monotonic()
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(command, cwd=REPO, stdin=subprocess.PIPE if request else subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=errors, preexec_fn=limit_fds, start_new_session=True)
        if request:
            proc.stdin.write(json.dumps(request).encode())
            proc.stdin.close()
        output = bytearray()
        peak = 0
        peak_threads = 0
        exceeded = False

        def consume():
            while True:
                chunk = proc.stdout.read(4096)
                if not chunk:
                    return
                output.extend(chunk)
                if len(output) > 64 * 1024 * 1024:
                    os.killpg(proc.pid, 9)
                    return
                if slow:
                    time.sleep(0.01)

        reader = threading.Thread(target=consume, daemon=True)
        reader.start()
        while proc.poll() is None:
            current_rss, current_threads = process_resources(descendants(proc.pid))
            peak = max(peak, current_rss)
            peak_threads = max(peak_threads, current_threads)
            if peak > args.rss_mb * 1024 * 1024 or time.monotonic() - started > 120:
                exceeded = True
                os.killpg(proc.pid, 9)
                break
            time.sleep(0.005)
        code = proc.wait(timeout=5)
        reader.join(timeout=5)
        errors.seek(0)
        error = errors.read(65536).decode(errors="replace")
        if exceeded or code != expected or reader.is_alive():
            raise RuntimeError(f"{name}: code={code}, expected={expected}, peak={peak}, deadline/budget={exceeded}: {error}")
        if expected:
            if "maxCandidates" not in error or b'"scan_completed"' in output:
                raise RuntimeError(f"{name}: resource exhaustion did not fail clearly")
            summaries = []
        else:
            summaries = [json.loads(line) for line in output.splitlines()]
            if slow:
                summaries = [event["summary"] for event in summaries if event.get("type") == "scan_completed"]
            if not summaries or (not allow_partial and any(s["exact"] is not True or s.get("skippedDirs", 0) != 0 for s in summaries)):
                raise RuntimeError(f"{name}: unexpected incomplete result under descriptor limit")
        return {"name": name, "exit": code, "elapsedMs": (time.monotonic() - started) * 1000,
                "sampledProcessTreePeakRssBytes": peak, "sampledProcessTreePeakThreads": peak_threads,
                "summaries": summaries, "error": error.strip()}


with tempfile.TemporaryDirectory(prefix="sweep-resource-stress-", dir=args.fixture_parent) as owned:
    root = Path(owned)
    flat = root / "flat/node_modules"
    flat.mkdir(parents=True)
    for i in range(args.files):
        (flat / str(i)).write_bytes(b"x")
    wide = root / "wide"
    for i in range(256):
        artifact = wide / str(i) / "node_modules"
        artifact.mkdir(parents=True)
        (artifact / "file").write_bytes(b"x")
    rows = []
    if args.sparse_gib:
        sparse = root / "sparse/node_modules"
        sparse.mkdir(parents=True)
        with (sparse / "large-file").open("wb") as handle:
            handle.truncate(args.sparse_gib * 1024 ** 3)
        if (sparse / "large-file").stat().st_blocks * 512 > 16 * 1024 * 1024:
            raise RuntimeError("fixture is not sparse; refusing resource qualification")
    for engine in ["js", "rust"]:
        for shape in ["flat", "wide"] + (["sparse"] if args.sparse_gib else []):
            command = [bun, "packages/core/benchmarks/engine-resource-sample.ts", engine, str(root / shape),
                       "true", str(BINARY), "{}", str(args.repeats)]
            row = run(f"{engine}-{shape}-rescans", command)
            expected_bytes = args.files if shape == "flat" else args.sparse_gib * 1024 ** 3 if shape == "sparse" else 256
            if any(s["estimatedTotalBytes"] != expected_bytes for s in row["summaries"]):
                raise RuntimeError("byte parity mismatch")
            rows.append(row)
    request = {"config": {"patterns": ["node_modules"], "ignore": [], "depth": -1, "maxSizeGB": 10},
               "selectionPolicy": {"mode": "default", "includeDangerous": False}, "exact": True, "jsonStream": True}
    rows.append(run("rust-slow-consumer", [str(BINARY), "scan", str(wide)], request, slow=True))
    request["limits"] = {"maxCandidates": 8}
    rows.append(run("rust-native-budget-failure", [str(BINARY), "scan", str(wide)], request, expected=2))
    result = {"platform": os.uname().sysname, "binarySha256": hashlib.sha256(BINARY.read_bytes()).hexdigest(),
              "files": args.files, "sparseGiB": args.sparse_gib, "existingTreeReadOnly": bool(args.existing_tree), "repeats": args.repeats, "fdSoftLimit": args.fds, "rssAbortMb": args.rss_mb,
              "cpuAffinity": sorted(os.sched_getaffinity(0)),
              "notes": "Sampled RSS includes the Bun host and native child; host UI rendering excluded. No forced GC. Warm cache. No leak or OOM-proof claim.",
              "rows": rows}

# Probe after owned fixtures are removed: the fixture parent may itself live
# inside the existing tree. Including synthetic data would inflate its totals.
if args.existing_tree:
    existing = Path(args.existing_tree).resolve(strict=True)
    for engine in ["js", "rust"]:
        row = run(f"{engine}-existing-read-only", [bun, "packages/core/benchmarks/engine-resource-sample.ts", engine,
                  str(existing), "false", str(BINARY), "{}", str(args.repeats)], allow_partial=True)
        rows.append(row)
Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"passed": len(rows), "output": args.output}))
