# Engine and UI measurements

Measured 2026-10-01 on Linux x64, Intel i5-13450HX, Bun 1.4.2, rustc 1.94.0,
release native engine, warm cache. Fixtures were generated under
`target/benchmark-fixtures` on ext4 and removed after the run. Host activity was
not fully isolated; raw data is attached so timings can be repeated and compared.
The benchmark alternates engine order, validates discovered candidate sets and
byte totals in both modes, and checks Linux single-artifact apparent totals
against du. Hardlink/Unicode regressions are tested separately; synthetic
fixtures do not prove universal engine parity.

The native binary SHA-256 in each JSON identifies the actual measured build.
Root source HEAD was `37012df` plus the shared traversal diff and continuation.
The `traversal-engine` source at `3e458e8` was reviewed separately; these
measurements use the root release binary, not that worktree's binary.

## Original 100-sample comparison

Each mode has three warmups then 100 samples per engine. Timings are milliseconds.
These include API scan-to-plan, Rust spawn/NDJSON and host plan construction.
They exclude CLI host startup, React/OpenTUI rendering, apply and fixture creation.

| Shape | Size mode | JS median | Rust median | JS empirical p99 | Rust empirical p99 |
| ----- | --------- | --------: | ----------: | ---------------: | -----------------: |
| small | apparent  |      6.60 |        6.68 |            10.85 |              10.08 |
| small | exact     |      4.73 |        7.41 |             6.69 |              11.60 |
| wide  | apparent  |     61.38 |       40.28 |           104.21 |              62.21 |
| wide  | exact     |     49.55 |       30.20 |            84.64 |              54.97 |
| dense | apparent  |     20.60 |        9.76 |            32.39 |              12.71 |
| dense | exact     |     49.31 |        6.83 |            67.90 |              13.11 |
| fat   | apparent  |     34.22 |       13.86 |            60.97 |              17.78 |
| fat   | exact     |    463.18 |       11.77 |          1182.02 |              64.78 |
| flat  | apparent  |     45.38 |       37.62 |            68.29 |              58.51 |
| flat  | exact     |    507.65 |       35.58 |           677.19 |              58.79 |

`small`: 32 artifacts × 8 files; `wide`: 1,024 artifacts × 3 files;
`dense`: 32 artifacts × 256 files. `fat`: one artifact × 20,000 files, in
313 directories of at most 64 files. `flat`: one artifact × 20,000 direct files.
Each file contains 128 bytes. File sizes do not represent large-file reads:
sizing reads metadata, not content. Nearest-rank p99 from 100 samples is an
empirical local quantile, not a production guarantee or a confidence bound.

[Raw samples, first discovery/size, heartbeat lag and resource probes](engine-results.json).

## 100,000-file scale gate

Seven samples after two warmups; report median and maximum. With seven samples
the harness's p99 field equals maximum; do not publish it as a qualified p99.

| Shape | Size mode | JS median | Rust median | JS maximum | Rust maximum |
| ----- | --------- | --------: | ----------: | ---------: | -----------: |
| fat   | apparent  |    139.15 |       47.30 |     176.81 |        54.86 |
| fat   | exact     |   2784.40 |       55.68 |    2987.54 |        62.92 |
| flat  | apparent  |    214.05 |      152.68 |     243.45 |       193.88 |
| flat  | exact     |   2351.20 |      144.97 |    2743.99 |       148.42 |

The nested single-artifact apparent-size gate passes on this Linux/ext4 run:
Rust median is below JS and both equal GNU du's byte total. No switch from JS's
du sizing was made. Exact mode intentionally has different hardlink/interior-link
semantics from apparent mode; equality is compared within the chosen mode.
[Scale samples and resource probes](engine-results-100k.json).

## Before and after

Before the shared-pool/subdirectory changes, the seven-sample nested 20k apparent
fixture took JS 26.40 ms / Rust 39.63 ms median. Afterward the larger 100-sample
run took JS 34.22 ms / Rust 13.86 ms. The old binary and new binary ran at
different times with different host load, so this is supporting diagnosis, not
a statistically controlled speedup ratio. The strongest comparison is the
alternating-engine result within one final run.
[Before snapshot, including binary hash](engine-before-20k.json).

## Resource observations and limits

GNU time probes run separate fresh Bun processes using the same streaming APIs.
The JSON retains full time reports including CPU, wall time, page faults and
maximum RSS. Twenty-k apparent fat probes ranged around 40–41 MiB for JS and
38–39 MiB for the Rust API host pipeline. The maximum RSS accounting reports a
per-process high-water value, not the sum of concurrently alive host/native/du
processes. It includes fresh runtime startup. Two probes per engine/mode cannot
establish leak absence or a production peak-memory envelope.

The code has bounded active workers, input channel and admitted sizing jobs.
Retained candidates, queued directory paths and inode sets still scale with the
tree. The Windows console cancellation callback uses a small documented unsafe OS
ABI call; traversal and sizing do not add unsafe filesystem access. No sanitizer, Valgrind,
repeated native library-process leak check, cold-cache or network filesystem
qualification was performed. Native scan subprocess exit releases its process
resources; that does not eliminate host or in-scan memory pressure.

## UI state measurements

The initial 30-sample state experiment after summary caching gave 50k-candidate
selection median 146 ms / p95 154 ms, while cursor-derived totals reused cached
inputs. This excluded rendering. The reproducible state benchmark below captures
current code and must be considered separately from real terminal latency.

```bash
bun run packages/ui/benchmarks/state-pipeline.ts
```

The refreshed 50k run took 171 ms median / 189 ms p95 for a selection toggle;
cursor cache reuse stayed below 0.012 ms p95 in state derivation. Background
activity and implementation changes make the runs incomparable as a speedup
ratio, and the latter exposed selection rebuilding as a UI bottleneck.

[Original UI state results](ui-state-results.json). The selection-cache
remediation is now implemented; see the refreshed measurements below.

## Refreshed remediation measurements

Measured 2026-10-02 against the final release binary, with 100 samples and three
warmups per engine/mode. The native hash is recorded in the JSON. All candidate
and byte parity assertions passed. The same warm Linux/ext4 and API-only scope
limits apply; foreground host activity was not isolated.

| Shape | Size mode | JS median | Rust median | JS empirical p99 | Rust empirical p99 |
| ----- | --------- | --------: | ----------: | ---------------: | -----------------: |
| small | apparent  |      3.79 |        4.60 |            13.48 |              10.81 |
| small | exact     |      2.11 |        3.85 |             4.19 |               4.85 |
| wide  | apparent  |     29.00 |       17.03 |            51.74 |              31.85 |
| wide  | exact     |     24.52 |       17.40 |            40.86 |              51.13 |
| dense | apparent  |     21.15 |        3.96 |            38.17 |               9.53 |
| dense | exact     |     14.19 |        3.50 |            25.35 |               6.17 |
| fat   | apparent  |     20.11 |        5.56 |            27.98 |              10.92 |
| fat   | exact     |    201.57 |        5.10 |           388.34 |               7.97 |
| flat  | apparent  |     33.22 |       26.66 |            39.37 |              33.04 |
| flat  | exact     |    188.41 |       18.42 |           362.21 |              30.27 |

[Refreshed raw scan samples](engine-results-remediation.json). Native large
nested sizing is faster here. JS's small-scan median and first discovery remain
faster; native wide exact p99 is worse in this run despite a lower median.
Those tails show why a universal Rust speed or production p99 claim is unwarranted.

The remediated 50k UI selection state benchmark took 8.710 ms median / 10.381 ms
p95 (maximum 11.396 ms). Cursor reuse was 0.00421 ms p95. Item identity and header
counts have regressions, including immediate queued-filter invalidation.
[Remediated UI samples](ui-state-remediation.json). These omit terminal rendering.

The remediated hardlink probe reports 2,000 apparent bytes for both engines and
both match a/b/emoji in the single-scalar wildcard fixture.
[Remediated edge probes](edge-parity-remediation.jsonl).

## Refreshed 100,000-file scale check

Final native binary, seven samples and two warmups; warm cache. Candidate and
byte parity pass for both modes. The harness's seven-sample p99 equals maximum,
so these results are medians and maxima only.

| Shape | Size mode | JS median | Rust median | JS maximum | Rust maximum |
| ----- | --------- | --------: | ----------: | ---------: | -----------: |
| fat   | apparent  |    120.76 |       25.98 |     125.91 |        27.02 |
| fat   | exact     |    943.34 |       17.06 |    1781.95 |        30.61 |
| flat  | apparent  |    110.15 |       78.55 |     115.86 |        82.92 |
| flat  | exact     |    946.93 |       82.91 |    1693.06 |       121.27 |

[Final scale samples and resource probes](engine-results-100k-remediation.json).
The nested apparent-size gate still passes; flat sizing remains a distinct
scaling limit. This does not qualify million-entry memory or network filesystems.

## Guarded apply measurements

Seven fresh owned fixtures per engine/shape, alternating engine order, with the
current-size ceiling enabled (10 GiB). These include revalidation, refreshed
sizing, native capability/startup/control and deletion, but exclude fixture
creation/cleanup and CLI rendering. Completed callbacks, reports and filesystem
absence agree in every run. Seven samples do not qualify p99.

| Shape | Engine | Median ms | Maximum ms |
| ----- | ------ | --------: | ---------: |
| many  | js     |      5.20 |       8.04 |
| many  | rust   |      5.75 |      44.83 |
| large | js     |    146.71 |     153.62 |
| large | rust   |     67.62 |      71.25 |

`many`: 64 artifacts × 16 files; `large`: one nested 20k-file artifact.
JS is faster on the small multi-artifact apply, while Rust is faster on the
large artifact. These measurements include the cost of stronger size guards;
do not compare them to unguarded deletion-only timing.
[Raw guarded apply samples](apply-results-remediation.json).

```bash
SWEEP_ENGINE_PATH="$PWD/target/release/sweep-engine" bun run packages/core/benchmarks/apply-comparison.ts --samples 7 --output /tmp/sweep-apply.json
```

## Reproduction

```bash
bun run engine:build
mkdir -p target/benchmark-fixtures
bun run packages/core/benchmarks/engine-comparison.ts --scenarios small,wide,dense,fat,flat --fat-files 20000 --fixture-parent target/benchmark-fixtures --samples 100 --warmups 3 --resource-samples 2 --output /tmp/sweep-20k.json
bun run packages/core/benchmarks/engine-comparison.ts --scenarios fat,flat --fat-files 100000 --fixture-parent target/benchmark-fixtures --samples 7 --warmups 2 --resource-samples 2 --output /tmp/sweep-100k.json
```

Linux resource sampling requires /usr/bin/time. SWEEP_ENGINE_PATH pins a binary.
The full method and options are documented in [testing](../../.docs/testing.md).
Filesystem cache state, background load and hardware change timings. Rust does
not win universally: small exact scans remain faster in JS; its first discovery
also precedes the native spawn/stream path. A flat directory limits subdivision.
OS-specific directory-fd optimization should be driven by profiles and parity,
not a promised universal speedup.
