# Audit remediation and qualification

- **Status:** `done` — code remediation verified locally; qualification remains
- **Scope:** `security`, `engine`, `protocol`, `ui`, `history`, `release`
- **Created:** 2026-10-02
- **Updated:** 2026-10-02
- **Commit:** `uncommitted`
- **Source:** root `37012df` plus the preserved shared diff

## Implemented behavior

The root checkout implements the actionable code findings A01–A17 from the
[audit register](audit.md). This is local remediation, not a release or a claim
that all filesystem, dependency or platform risks have been eliminated.

| Findings              | Change                                                                                                                                                 | Verification                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A01/A03/A05           | Bounded wildcard matching; global JS discovery budget; Rust HashSet selection lookup                                                                   | Matcher, traversal, selection and parity regressions                                                                                           |
| A02/A06               | Controlled native plan/start/cancel channel; live begin/deleted events; final deleted/failed/covered/unattempted partition for every selected ID       | Both engines: duplicate/nested selection, pre-abort, type drift, counts and callbacks; native live cancellation and closed-start-channel tests |
| A02 terminal boundary | Unix apply child has a separate process group; Windows console callback sets the cancellation atomic                                                   | Linux owned foreground-group SIGINT regression; Windows runtime qualification pending                                                          |
| A02 failure boundary  | Cancellation drains the report; 30-second stuck-child watchdog and post-begin crash/malformed output explicitly report unknown outcomes, without retry | Owned fake-child timeout, crash and bad-output regressions                                                                                     |
| A04                   | Cache row topology/order and scope structure; reuse item rows; compute group metrics once and scope totals in one postorder                            | Queued filters and header-count regressions; 50k state benchmark                                                                               |
| A07/A08/A15           | Failed roots are errors; discovery iterator/type errors increment skipped directories once; unknown sizes retain partial totals and bytesKnown=false   | Root/parity tests, injected entry/type errors and incomplete-sizing tests                                                                      |
| A09                   | Native/JS sparse size timers; drain admitted work on failures; stop worker panics without hanging                                                      | Timer, failure-drain, panic and progressive-channel regressions                                                                                |
| A10                   | History reads at most 8 MiB through checked regular handles; private POSIX files; reject symlinks; unique whole-file rotation with four archives       | Sparse 128 MiB tail, rotation, symlink and torn-record tests                                                                                   |
| A10 reporting         | Stats describe retained history and plan estimates; deletion summaries distinguish actual operations, covered and unattempted selections               | Display/CLI tests; shared reporting contract                                                                                                   |
| A11                   | Bounded native version/capability probes; availability keyed to resolved binary identity and environment                                               | Probe replacement, timeout and fallback tests                                                                                                  |
| A12/A13               | Execute packaged Linux ARM64 native binary and apply tests; add CI doc gate; fix obsolete commands/platform/default-engine docs                        | Local docs/package smoke checks; hosted platform results pending                                                                               |
| A14                   | Refresh selected/revalidated/deduplicated sizes before apply; reject unknown or over-limit observations; preserve explicit force-large bypass          | Both engines: post-scan growth and force override regressions                                                                                  |
| A16/A17               | Per-artifact hardlink accounting; Unicode scalar wildcard length/matching and Unicode case lowering                                                    | Shared hardlink/emoji probes and matcher tests                                                                                                 |

Rust discovery uses bounded blocking workers with LIFO/steal scheduling, sharded
visited state, panic propagation and idle backoff. Sizing runs on one shared
eight-thread Rayon pool with 32 admitted artifact jobs, a bounded 256-entry input
channel and bounded subdirectory subdivision. An async runtime or async mutex
would not remove the blocking filesystem calls; short bookkeeping locks and
explicit lifecycle control match this workload. Candidate/path/identity storage
still grows with the tree.

JS apparent batches now use bounded in-process metadata walking, so hardlinks
do not depend on which artifacts happen to share a sizing invocation. Both
engines price regular files and symlinks without following leaf links, exclude
directory metadata, and deduplicate hardlinks within an artifact. Unreadable
subtrees report `bytesKnown: false` with a lower-bound byte count rather than
claiming an exact total. Exact mode remains a separate contract. These are
apparent-byte estimates, not physical disk reclaim.

## Progressive feedback

The first discovered row appears immediately; later updates coalesce by candidate
ID over 60 ms or 200 pending entries. Native size events flush on a 16 ms timer,
including sparse tails. The UI distinguishes discovery, pending sizes and partial
totals. A failed scan stays visibly INCOMPLETE, and cannot apply or export an
executable plan until a successful finalized scan. Selection changes reuse
structural order; queued/unqueued filters still update immediately.

Apply progress comes from actual native begin/deleted events. A nested or
duplicate selection covered by another operation is not reported as an additional
deletion. Cancellation finishes the current removal and leaves later selections
unattempted. If the trusted final report is lost, the error explicitly requires
inspection before retrying rather than inferring success or replaying deletion.
History remains best effort, not a durable recovery journal.

## Measurements

[The benchmark report](benchmarks.md) records shapes, raw samples, native hashes,
time to first discovery/size, event-loop heartbeat and resource limitations.
Latest results are in [scan samples](engine-results-remediation.json),
[100k scale samples](engine-results-100k-remediation.json),
[apply samples](apply-results-remediation.json), [UI state samples](ui-state-remediation.json)
and [edge parity](edge-parity-remediation.jsonl). Scan comparisons use 100 samples
after warmups and alternate engine order. Apply's seven samples qualify only
exploratory medians/maxima. All apply fixtures are owned temporary trees.

The 50k selection state pipeline measured 8.710 ms median / 10.381 ms p95,
compared with the earlier 171 ms median / 189 ms p95 snapshot. These exclude
React/OpenTUI rendering and were taken under different host activity; they are
evidence of reduced derivation cost, not a guaranteed terminal latency or a
controlled speedup ratio. JS remains useful for small scans/applies; Rust's
subprocess and control-channel overhead is visible there.

## Verification

[Machine-readable gate snapshot](verification.json).

- `bun run check`: format, lint, typecheck, doc links and 542 Bun tests pass
  (16 protocol, 4 display, 208 core, 20 CLI, 246 UI, 48 integration).
- `bun run rust:check`: Rust formatting, clippy with denied warnings and 66
  unit/integration tests pass.
- Release native build, `bun run build` and `bun run engine:verify` pass. The
  built CLI contains the updated cancellation/error/reporting bridge.
- Strict all-target Rust clippy also passes with warnings denied.
- The built TUI was exercised in an owned Linux PTY: four Rust-scanned artifacts,
  selection toggle, confirmation, Esc cancellation and q exit. It returned the
  documented aborted status (1) and all artifacts remained. Confirmation and
  progress now describe selected byte estimates rather than guaranteed reclaim.
- Benchmark scripts pass standalone strict TypeScript and oxlint with no warnings.
- `bun run preflight` returns 1 solely because the source tree is uncommitted.
  All 20 functional package checks pass; the publish guard is preserved rather than
  bypassed. This is not a release-ready preflight pass.

The separate [traversal-engine worktree](traversal-review.md) was reviewed at
`3e458e8` and not merged. Its unrelated dirty bun.lock/package.json/turbo.json
tooling changes were preserved. Root shared work was preserved; nothing was
committed, published or deployed by this remediation.

## Remaining qualification and product work

1. Run hosted Windows/macOS/ARM64 package tests and actual Windows console
   interrupts. Linux process-group tests do not establish those platform results.
   The owned Linux PTY smoke is limited to a small fixture; real terminal
   emulators, SSH and multiplexers still need broader interactive UX proof.
2. Exercise cold caches, NFS/FUSE, disappearing entries, permissions, deep/flat
   million-entry trees, slow consumers, and concurrent scans under descriptor and
   memory pressure. Warm local p99 is not a production latency guarantee; bounded
   workers are not a hard total-memory cap or a leak-freedom proof.
3. Destructive boundaries still recheck pathnames rather than pin directory
   handles. Ancestor swaps after revalidation, same-kind replacements, mount
   boundaries and growth after the size observation remain threat-model limits.
   No race-proof deletion or atomic physical size-cap claim is justified.
4. Dependency advisories are unverified. Automatic approval review rejected the
   npm dependency-metadata upload without specific approval; cargo-audit is not
   installed. No zero-vulnerability assertion follows from code checks.
5. History retention intentionally drops old archives; concurrent writers can
   have an already-open archived inode. Do not use retained totals as lifetime
   savings or assume durable interruption recovery.
6. Public receipts, a reproducible demo, restore/purge and doctor are concrete
   product opportunities in [the growth options](audit.md#product-direction-and-growth-options).
   Public sharing must omit executable plans and private paths by default.
   None was silently added as an upload or telemetry feature. Virality requires
   adoption evidence, not a speed claim.

The existing source versions remain CLI `0.3.1`, Rust workspace `0.1.0` and
protocol `1`. New optional outcome fields preserve reading of old reports; old
native apply engines are refused if they cannot satisfy controlled cancellation.
A changeset records the user-visible fixes; versioning and release are separate
actions.
