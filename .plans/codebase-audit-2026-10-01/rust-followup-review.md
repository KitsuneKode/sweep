# Rust backend follow-up review

- **Status:** done — reviewed and fixed locally; production qualification remains
- **Scope:** engine, destructive operations, transport, performance
- **Created:** 2026-10-03
- **Updated:** 2026-10-03
- **Commit:** uncommitted
- **Source:** main `cc7dab6` plus the preserved working tree; inline execution
- **Worktree:** `traversal-engine` remains `3e458e8`, preserved without integration

The subsequent [saved-plan identity work](../saved-plan-identity.md) extends the
pins back to discovery, adds legacy refusal and fixes JS alias receipts. Its
benchmark/resource JSON records a newer executable hash. Measurements below
qualify this earlier pass and are not silently relabeled as that binary.

## Findings fixed

| Finding                                                                   | Reproduction                                                                             | Result                                                                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Cancellation set during native begin feedback still deletes the entry     | Apply callback sets the cancellation flag; old code invokes deletion anyway              | Recheck immediately after begin; unattempted outcome and intact entry                                                                    |
| JS has the same cancellation gap for delete and trash                     | `onBegin` sets cancellation in an owned fixture                                          | Neither deletion nor move starts; no success/progress claim                                                                              |
| Same-type replacement can be deleted during apply                         | Begin callback renames the original away and creates a new directory at its path         | Rust pins revalidated leaf identities; JS compares exact BigInt identities across begin; replacement survives with failure               |
| Trash root replacement at the same spelling is accepted                   | Begin callback renames the trash root away and creates a new directory at the same path  | Exact BigInt root identity is pinned alongside its canonical path; source and replacement sentinels survive with failure                 |
| Covered alias child becomes unattempted after parent removal              | Select a parent and a child reached through an internal symlink alias                    | Native alias keys are frozen before destructive operations; child is covered by the deleted parent                                       |
| Invalid UTF-8 dirents can name another real file                          | Create raw `FF.tmp` and valid `�.tmp`; both engines previously emit the valid path twice | Skip unrepresentable discovery names and mark the containing directory incomplete; valid Unicode and raw subtree sizing remain supported |
| Final-output bound measures characters rather than bytes                  | Fake engine emits 72 MiB UTF-8 but only 24 MiB of JS characters                          | Host refuses output at 64 MiB before retaining/parsing the oversized chunk                                                               |
| Native size preflight cannot cancel within a large subtree                | Cancellation is checked only between candidates                                          | Controlled sizing polls within enumeration; cancellation does not poison the budget; path/identity reservations are returned             |
| Stable Windows build fails                                                | Cross-check reproduces seven nightly metadata/type errors                                | Stable metadata-only, non-following owned handles supply volume, file index and link counts; discovery/sizing/apply share the helper     |
| Direct native SIGINT loses the report                                     | Previous release exits -2 after deletion starts, without `apply_completed`               | Checked Unix SIGINT/SIGTERM handlers set an atomic flag; controlled and legacy apply flush their partitions; legacy exits 1              |
| Focused-deletion PTY harness mistakes a background path for inspect scope | Failing trace shows correctly confirmed/deleted bravo, while harness waits for alpha     | Read the labeled inspector path and verify confirmation preview; six consecutive owned-fixture passes                                    |

Native root identity/volume checks now cover Windows as well as Unix. Identity
checks narrow replacement windows; they are not atomic containment and do not
detect every change between an earlier scan and apply. File contents can change
without changing the inode. No new protocol guarantees are implied.

## Review coverage

Reviewed native scan/config admission, worker termination, sizing reservations,
hardlink accounting, Unicode conversion, callback order, final serialization,
stdin/control framing, signals, selected-ID validation, nested dedupe, canonical
root/parent/VCS checks, leaf type dispatch, current-size ceiling and outcome
partitioning. Reviewed the JS bridge/cleaner at the corresponding boundaries.
Existing guardrail, malformed-stream, deep-tree and resource tests remain part
of the required gates. Additional deletion tests verify that recursive removal
preserves interior symlink targets and external hardlink contents; all mutations
use owned temporary fixtures. Windows hardlink sizing now has a runtime test
in the existing platform matrix.

No payload rewriting or experimental traversal runtime was added. Native
blocking filesystem work stays on bounded pools; locks protect short accounting
and set operations. The new Windows metadata handles close through `File` RAII.
Linux ordinary-file sizing does not allocate paths for the Windows helper.
Cooperative cancellation cannot interrupt a blocked kernel filesystem syscall.

## Fresh measurements

[Final scan JSON](engine-results-rust-review-final.json): Bun 1.4.2, Linux x64,
100 alternating samples, three warmups, warm filesystem cache, release native
SHA `000d9f5e410ba0a7d2b28d6cc32f81b181a1f4019d5e364c5592d2ac45a6ee6e`.
Includes process startup, transport and JS planning; excludes CLI/TUI rendering.
These are empirical nearest-rank percentiles, not production SLO guarantees.

| Shape, apparent mode                       | JS p50 / p99       | Rust p50 / p99   |
| ------------------------------------------ | ------------------ | ---------------- |
| 1,024 artifacts                            | 158.81 / 220.06 ms | 20.50 / 27.12 ms |
| One 20,000-file artifact with subdivisions | 205.44 / 235.81 ms | 5.37 / 6.56 ms   |
| One flat 20,000-file artifact              | 143.97 / 174.04 ms | 19.87 / 23.57 ms |

The native wide-case host event-loop lag p99 remains 10.13 ms, versus JS 2.71 ms.
Total scan speed and UI input latency are separate metrics. Profile host parse,
validation, planning and painting before changing thread counts or batching.
[Earlier same-pass JSON](engine-results-rust-review.json) records the pre-signal
handler binary separately; do not mix hashes when comparing measurements.

[Release apply JSON](apply-results-rust-review-p99.json): 100 alternating
owned-fixture runs per engine per shape, refreshed-size guard enabled. All 400
runs verified outcome counts, callback counts and absence of deleted paths.
Includes validation, fresh sizing, native startup/control and deletion; excludes
fixture creation and cleanup. Same release hash as the final scan evidence.

| Deletion shape              | JS p50 / p99       | Rust p50 / p99    |
| --------------------------- | ------------------ | ----------------- |
| 64 artifacts, 16 files each | 39.94 / 46.73 ms   | 11.61 / 15.76 ms  |
| One 20,000-file artifact    | 280.68 / 352.88 ms | 92.31 / 101.89 ms |

These are local empirical percentiles, not cold-storage, physical-reclaim or
production SLO qualification. The [earlier seven-run JSON](apply-results-rust-review.json)
remains exploratory. A [separate debug-build run](apply-results-rust-review-debug-p99.json)
is labeled by path and hash; development's newest-build resolution selected it.
The apply harness now pins the release executable by default, matching the scan
harness, while honoring an explicit `SWEEP_ENGINE_PATH`.

[Resource JSON](resource-rust-review.json): eight checks passed with 100,000
one-byte files, three repeated scans, FD limit 64, sampled process-tree RSS
watchdog 512 MiB, slow native reader and explicit tiny-budget failure. Peak
host-plus-engine observations: JS 133.1 MiB, Rust 53.9 MiB. The sparse 200 GiB
fixture verifies large counters and metadata behavior; it is not 200 GiB of
allocated-data deletion or measured space reclamation. The watchdog is harness
instrumentation, not a production memory limiter or leak proof.

Native executable: 989,488 bytes; compiled CLI: 102,811,104 bytes. Standalone
still bundles 202 modules and excludes docs framework dependencies. The native
asset is under 1 MiB; the standalone includes Bun/OpenTUI and remains about
98 MiB uncompressed. Embedded scan works with empty PATH and UI module loading
passes. Broken-output standalone apply stops future scheduling for both engines
and persists outcomes matching the fixture's remaining artifacts.

Reproduce:

```bash
bun run engine:build
bun run packages/core/benchmarks/engine-comparison.ts --samples 100 --warmups 3 --scenarios wide,fat,flat --fixture-parent target/sweep-test-tmp --output target/scan-review.json
bun run packages/core/benchmarks/apply-comparison.ts --samples 100 --fixture-parent target/sweep-test-tmp --output target/apply-review.json
python3 scripts/resource-stress.py --files 100000 --repeats 3 --fds 64 --rss-mb 512 --sparse-gib 200 --fixture-parent target/sweep-test-tmp --output target/resource-review.json
```

Create the ignored fixture-parent directory first. These benchmarks never delete
an existing project. Storage capacity checks precede the resource fixture;
quotas may still cause a safe fixture-creation failure.

## Required work before stronger production claims

| Priority     | Area                                   | Concrete next work and acceptance                                                                                                                                                                                                                                                                                         |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0           | Ancestor replacement and nested mounts | Design descriptor/handle-relative deletion anchored to the approved root. Reject cross-device and same-device bind-mount descendants. Adversarial mount/rename/symlink tests must preserve every outside sentinel. Keep a portable, explicit unsupported-case policy; extra pathname checks are not a substitute.         |
| P0           | Real platform execution                | Run stable builds, installed npm/standalone packages, NTFS/ReFS/SMB identities, junctions, macOS filesystem/case rules, ARM64, Ctrl-C/job control and TTYs on actual runners. Windows cross-compilation is not execution.                                                                                                 |
| Done locally | Saved-plan freshness                   | [Saved-plan identity work](../saved-plan-identity.md) now captures root/leaf snapshots during scanning and refuses older plans or replacements. Content changes, inode reuse, atomic containment and actual platform qualification remain separate limits.                                                                |
| P1           | Trash and competing applies            | Qualify overlapping processes, case-sensitive macOS/Windows volumes, normalization collisions, replaced trash ancestors and claim slots. Move receipts must identify the actual destination. Cooperative locks cannot defend against external writers; do not advertise atomic containment or complete restore semantics. |
| P1           | Partial deletion and crash recovery    | Failed recursive removal may have removed descendants. Report that clearly; never auto-retry destructive work. Specify a private crash-durable intent/outcome journal and recovery semantics before implementing automatic resume/undo. History currently remains best-effort.                                            |
| P1           | Filesystem failures                    | Qualify disk-full history/trash writes, readonly/permission transitions, quota exhaustion, open-file Windows behavior, antivirus/indexer contention, network disconnects and slow/blocking metadata calls. Verify outcomes and preservation, not only exit codes.                                                         |
| P1           | Resource scaling                       | Retention limits still stop oversized scans and remain logical accounting. Measure many-candidate UI/host heap and process-tree peaks under low memory; consider compact paths/paged retention only with explicit selection semantics and measured benefit. No silent candidate dropping.                                 |
| P1           | Performance at scale                   | Warm local scan and deletion now have 100 samples per shape. Add cold-storage/network workloads and isolate physical reclaim. Use allocated fixtures only within verified disposable storage capacity; available local disk cannot qualify allocated 200 GiB deletion.                                                    |
| P1           | Supply chain and release               | Separate dependency advisory/license provenance, signed/checksummed artifacts, real installers and reproducible CI evidence from source review. This pass does not establish security-clean dependencies or authorize publication.                                                                                        |
| P2           | Developer and UI latency               | Profile decoder/validation/planner separately from terminal painting on 50k candidates; pace processing within an input-latency budget while preserving bounded backpressure and final consistency. Qualify keyboard/resize/focus and docs browser/mobile behavior.                                                       |

The current std recursive remover already protects against interior symlink
races on supported mainstream platforms; replacing it with an ad hoc pathname
walker can regress safety. The surrounding root/ancestor/mount contract needs
its own design and qualification. See [Rust removal semantics](https://doc.rust-lang.org/std/fs/fn.remove_dir_all.html),
[Windows handle metadata](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle),
and [Linux resolver constraints](https://man7.org/linux/man-pages/man2/openat2.2.html).

Verification passed: `bun run check` (48 tasks, 650 Bun tests and doc links),
`bun run rust:check` (8 tasks, 87 Rust tests), Linux all-target clippy, stable
Windows all-target cross-clippy, CI YAML validation and `git diff --check`.
The rebuilt standalone passed empty-PATH native scan, UI loading and interrupted
output checks. Six focused-deletion PTY runs preserved the other artifact.

Nothing was committed, merged, published or deployed by this pass. The separate
traversal worktree's dirty files were preserved. Required gate and runtime
evidence is recorded in [the evidence JSON](rust-followup-evidence.json).
