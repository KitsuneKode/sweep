---
title: Benchmarks and distribution size
description: Read the measured workload, conditions and limits before comparing speed or memory.
---

These are local source measurements, not guarantees for every device. Tests used
Linux x64, an Intel Core i5-13450HX, Bun 1.4.2 and warm local filesystem caches.
Each workload is tied to its recorded executable hash. Rust means the native
engine reached through the Bun host; JS means the
bounded JavaScript engine with its Node enumeration worker.

## Repeated large-tree scans

Two repeats used a soft 64-descriptor limit and a sampled 512 MiB process-tree
RSS watchdog. Both engines returned equal totals, with no unknown sizes or
skipped directories. RSS includes host and children.

| Workload                                                      | Rust time     | JS time         | Rust peak RSS | JS peak RSS |
| ------------------------------------------------------------- | ------------- | --------------- | ------------- | ----------- |
| 1 million files in one flat artifact, exact sizing            | 1.08 / 1.06 s | 9.10 / 7.84 s   | 45.6 MiB      | 131.6 MiB   |
| Existing project tree: 609 artifacts, 30.18 GB apparent total | 0.96 / 0.80 s | 23.32 / 18.73 s | 69.9 MiB      | 379.4 MiB   |
| One 200 GiB sparse file, exact sizing                         | 9.0 / 2.4 ms  | 41.6 / 30.7 ms  | 44.9 MiB      | 92.0 MiB    |

Sparse sizing verifies large counters and metadata; it does not read, allocate or
delete 200 GiB of contents. The existing tree was scanned read-only after owned
benchmark fixtures were removed. Two repeats are not a p99 estimate or a leak proof.

## Empirical latency tails

The October 4 CPU-aware follow-up also passed ten rescans per engine/shape with
one-CPU affinity, 32 descriptors and a sampled 192 MiB watchdog. For the flat
20k-file artifact, sampled host-plus-child peaks were 47.1 MiB Rust and 123.7 MiB
JS; the 256-artifact wide fixture peaked at 65.6 MiB Rust and 127.1 MiB JS.
Both returned complete, equal totals. The sparse 200 GiB counter check,
slow-consumer stream and explicit candidate-budget refusal also passed.
These observations exclude UI rendering and do not simulate a physically
low-memory device. Ten samples under variable host load do not establish p99
or a speed improvement. The following latency table retains its earlier hash.

The October 4 paced-stream build collected 100 warm-cache samples per scenario
after three warmups.
They exclude terminal rendering and CLI startup.

| Exact-sizing shape                                | Rust p50 / p99   | JS p50 / p99       |
| ------------------------------------------------- | ---------------- | ------------------ |
| 1,024 artifact projects                           | 21.90 / 30.69 ms | 167.38 / 386.03 ms |
| 20k files across directory groups in one artifact | 5.29 / 6.60 ms   | 193.97 / 225.18 ms |
| 20k files in one flat artifact directory          | 19.16 / 23.12 ms | 139.71 / 166.56 ms |

The recorded p99 is an empirical quantile on one host, not a production service
objective. Storage, background load, tree shape and permissions change results.
The wide Rust stream produced about 11 ms p99 host event-loop delay;
stream parsing/validation remains worth profiling separately from traversal.

## Cleanup and UI responsiveness

The October 4 anchored-removal build collected 100 apply samples per engine per shape, with
all 400 runs verifying the outcome and removed paths. Timing includes fresh
sizing, validation, native startup/control and deletion, excluding fixture setup.

| Owned deletion shape        | Rust p50 / p99     | JS p50 / p99       |
| --------------------------- | ------------------ | ------------------ |
| 64 artifacts, 16 files each | 13.05 / 19.14 ms   | 54.38 / 63.93 ms   |
| One 20k-file artifact       | 114.65 / 139.22 ms | 295.84 / 401.78 ms |

The additional containment checks cost work compared with earlier runs. Apply
and resource records precede the final host transport regression fixes; the
scan table follows them. Earlier measurements retain their own hashes and dates.

Million-entry deletion and physically allocated 200 GB removal remain unqualified.
The new 100k-file resource run passed eight checks with three rescans, FD limit
64 and a sampled 512 MiB watchdog; peak host-plus-child RSS was 53.5 MiB Rust
and 127.8 MiB JS. These observations do not prove leak absence or OOM immunity.

A separate 50k-candidate UI state benchmark measured selection p50 13.67 ms and
p95 18.94 ms. Cached cursor movement was sub-millisecond. This is state processing,
not a measurement of every terminal's painting or a complete user interaction.

Thirty synthetic sessions with 10k candidates each exercised navigation,
unqueue and cache release without forced GC. Peak RSS was 222 MiB, and the
slowest batch of 100 cached cursor moves took 1.28 ms. Ten-repeat Linux resource
checks used 10k-file shapes, a 64-FD limit and a 512 MiB sampled watchdog.
These are bounded session observations, not a soak test of hours of terminal
rendering or proof that heap usage will stay constant on arbitrary trees.

## Distribution size

Earlier local Linux x64 distribution measurements, October 3, 2026:

| Artifact        | Size                                  | Included                                                |
| --------------- | ------------------------------------- | ------------------------------------------------------- |
| npm CLI tarball | 492 KiB compressed; 2.11 MiB unpacked | Bundled CLI/library/UI JS, manifest, README and license |
| Rust engine     | 959 KiB raw; 454 KiB gzip estimate    | Native scan/apply engine; not the full UI app           |
| Full standalone | 98.0 MiB raw; 41.7 MiB gzip estimate  | Bun, terminal UI/native assets and Rust engine          |

The October 4 native executable is 1,031,584 bytes (about
1007 KiB); the rebuilt standalone remains about 98 MiB. The evidence summary
records its exact byte count and native hash separately from the earlier
compression/package measurements above.

The npm number excludes installed dependencies, optional native engine packages
and an existing Node/Bun runtime. The standalone trades size for a self-contained
runtime and UI. It should not be advertised as a 1 MB full application.

The final October 4 npm dry-run measured 510,101 compressed bytes and 2,241,220
unpacked bytes, still six allowlisted files. Commander is bundled and omitted
from published dependencies; docs-site assets remain outside this package.

Release workflow changes add round-trip-verified gzip assets and checksum sidecars
alongside raw binaries. Current measurements are local; compressed release assets
are available only after that workflow ships successfully. The existing installer
continues to use raw checksummed assets. Extract a downloaded gzip archive before
running the binary, preserving its executable permissions on Unix.

CLI preflight caps combined JS bundles at 4 MiB and rejects unexpected dist files.
The docs content and future website dependencies stay outside package artifacts.
Smaller npm delivery is the practical option when you already have the runtime;
the standalone is convenient when you need a self-contained download.

## Reproduce

From a source checkout with Bun, Node, Python 3, Cargo and the release engine:

```sh
bun install --frozen-lockfile
bun run engine:build
mkdir -p target/benchmark-fixtures
bun run packages/core/benchmarks/engine-comparison.ts --scenarios small,wide,fat,flat --fat-files 20000 --fixture-parent target/benchmark-fixtures --samples 100 --warmups 3 --output target/sweep-latency.json
python3 scripts/resource-stress.py --files 100000 --repeats 2 --fixture-parent target/benchmark-fixtures --output target/sweep-resources.json
bun run packages/core/benchmarks/apply-comparison.ts --samples 100 --fixture-parent target/benchmark-fixtures --output target/sweep-apply.json
bun run packages/ui/benchmarks/state-pipeline.ts
npm pack -w @kitsunekode/sweep --dry-run
```

The resource harness is Linux tooling and deletes only its owned temporary fixture.
Million-entry probes are opt-in, require roughly 4 GiB plus sufficient inodes,
and should not be run on a nearly full device. Sparse 200 GiB probes are also
opt-in with `--sparse-gib 200`. Existing-tree probes are read-only and must not be
confused with apply benchmarks. Run latency and resource probes sequentially.

Publish raw workload conditions, engine identity, sample count and unknown/skipped
sizes with any comparison. Use [the public evidence summary](../benchmark-results.json)
for these documented figures. No direct fzf/fff benchmark was performed: they
serve different search/indexing workloads, and these results do not establish a
ranking against them.
