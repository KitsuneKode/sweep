# Large-tree and focused-delete qualification

Base: main `cc7dab6`; this pass is uncommitted. The user paused the competing
session and assigned ownership here. Its full dirty patch and reader prototype
were archived under ignored `target/` before reconciling the bounded reader.
The older traversal-engine worktree was reviewed and its dirty changes preserved;
it is not an ancestor of main and was not merged wholesale. No existing project
was modified by the read-only probes.

## Current resource evidence

[Raw results](resource-200gib-and-projects.json) identify the native binary by
SHA-256. Two runs under a soft 64-descriptor limit and sampled 512 MiB process-tree
RSS watchdog produced equal totals and no unknown sizes or skipped directories:

| Shape                                                           | Rust completion  | JS completion      | Rust peak RSS | JS peak RSS |
| --------------------------------------------------------------- | ---------------- | ------------------ | ------------- | ----------- |
| 1,000,000 files in one flat artifact, exact                     | 1,079 / 1,065 ms | 9,097 / 7,845 ms   | 45.6 MiB      | 131.6 MiB   |
| Existing Projects: 609 artifacts, 30,182,297,457 apparent bytes | 960 / 803 ms     | 23,316 / 18,734 ms | 69.9 MiB      | 379.4 MiB   |
| Owned 200 GiB sparse file, exact                                | 9.0 / 2.4 ms     | 41.6 / 30.7 ms     | 44.9 MiB      | 92.0 MiB    |

The existing-tree probe now runs **after owned fixtures are removed**. Earlier
853-candidate / 244.8 GB figures accidentally included those fixtures and are
superseded by this artifact. These APIs exclude terminal rendering and CLI startup.
JS RSS includes its Node enumeration child; Rust RSS includes Bun and the native
child. Two samples are not p99 qualification or proof against all memory leaks.
The sparse file verifies large counters and metadata, not reading/removing 200 GiB
of allocated data. Apparent sizes are not physical bytes reclaimed.

The bounded reader uses true Node `opendir` under Bun, 128-name transport batches,
credit-based requests and deterministic disposal; raw invalid-UTF8 names survive.
The paused materialized-listing prototype was not retained. Unknown dirent types
still get the required `lstat` fallback. Lack of Node is explicit in the Bun JS
fallback; native and the embedded standalone smoke work without it.

## Latency, apply and UI

[100-sample warm-cache comparison](engine-results-resource-bounds.json), with
three warmups and sequential fixtures, records empirical p50/p99:

| Exact shape                                     | Rust p50 / p99   | JS p50 / p99         |
| ----------------------------------------------- | ---------------- | -------------------- |
| 1,024 artifact projects                         | 25.79 / 35.27 ms | 269.83 / 325.04 ms   |
| One artifact, 20k files across directory groups | 8.02 / 50.83 ms  | 365.70 / 1,542.01 ms |
| One artifact, 20k files in a flat directory     | 28.11 / 35.61 ms | 242.14 / 283.93 ms   |

This is one host and warm local storage, not a portable production p99 promise.
Rust's wide-tree bridge still shows about 13-16 ms empirical p99 event-loop delay;
profiling candidate parsing/validation batches is a remaining UX opportunity.

[Guarded apply comparison](apply-results-resource-bounds.json) includes fresh
sizing, validation and removal of owned fixtures. For one 20k-file artifact,
Rust median/max is 126.62/160.74 ms, JS 491.72/554.64 ms. Seven samples do not
qualify p99; the 64-artifact case includes a Rust maximum outlier of 75 ms.
Million-entry removal and physically allocated 200 GB removal remain untested.

[UI state pipeline](ui-state-resource-bounds.json): 50k-candidate selection p50
13.67 ms / p95 18.94 ms; cached cursor movement is sub-millisecond. This excludes
terminal painting and full scan-stream processing.

## Current fixes and verification

- Separate shared live sizing reservations prevent cumulative starvation and
  concurrent per-job limits multiplying retained data. Discovery caps stay fatal;
  sizing saturation remains visible as partial data. Limits are logical accounting,
  not a process RSS ceiling or absolute OOM immunity.
- Inspect pins the displayed candidate ID. `x`/`d` requests exactly that artifact's
  confirmation and uses the guarded backend apply path. It does not expand to the
  current scope or queued hidden candidates.
- The OpenTUI render regression verifies no result before `y`. The actual Linux
  PTY smoke inspected bravo, confirmed only it and preserved alpha.
- Settled source passed `bun run check`, `bun run rust:check`, release build,
  standalone bytecode compilation and empty-PATH embedded-native scan smoke.
  Final check reports 627 passing Bun tests; Rust reports 77 passing tests.
  Local package preflight passes operational/size checks and stops only at its
  uncommitted-source release guard.
- Turbo was upgraded to 2.11.7; required gates also passed with four-task
  concurrency and uncached filesystem/native checks. See
  [task-policy evidence](turbo-qualification.json).

## Release gates still open

Actual Windows/macOS/ARM64 consoles and installed packages, cold/remote storage,
nested mount containment and concurrent destructive path replacement need further
qualification. Current pathname guards do not give absolute deletion immunity.
Dependency advisory upload was not approved; no advisory-clean claim is made.
No commit, tag, registry write, deployment or release was performed by this pass.

Public docs: [guide hub](../../docs/index.md) is authored separately from internal
plans; the website is planned, not built or deployed. Distribution measurements
are recorded in [size evidence](distribution-size.json); compressed standalone
assets passed streaming round-trip verification locally. The PTY smoke now waits
for the visible estimated-byte receipt and drains output during shutdown.
