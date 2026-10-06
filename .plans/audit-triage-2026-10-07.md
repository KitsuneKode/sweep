Status: in_progress
Scope: security, engine, ui, packaging, automation
Created: 2026-10-07
Updated: 2026-10-07
Commit: ba9741a (source checkpoint; release qualification continues)

# Supplied audit triage and release boundaries

Source: the user's 45-item read-only audit and subsequent size/refusal and
concurrency reports. Findings are leads until checked against current code.
Work was performed inline; the dirty traversal-engine worktree was preserved.
“Implemented” below refers to this checkpoint, not publication or platform proof.

## Verified changes

- Same-drain dismiss/confirm, repeated confirmation, trash toggle and Ctrl-C races
  were reproduced. Live modal/operation refs now serialize both bulk and single
  apply. Deletion stays in the TUI with current path, elapsed time, counts,
  validation/sizing progress and cancellation; completed deletion is not undone.
- The screenshot failure was a size refusal, not an incomplete scan. Early
  estimate refusals create no journal. Explicit native and JS fresh-size refusals
  complete all-unattempted receipts. Known size/lock refusals preserve the queue;
  unknown reports still require rescan. Confirmation shows the GiB ceiling and
  prioritizes dangerous/caution entries using a three-entry linear preview.
- Protected-root canonical/inode aliases, VCS scan roots, proc task roots and
  direct JS apply leaf-symlink validation have regressions. Owned private Linux
  mount qualification covers protected-root aliases and nested same-device binds.
- Combined logical discovery/sizing bounds and a public low-memory profile are
  implemented in both engines. They do not cap whole-process RSS. JS preflight
  yields between bounded validation batches; programmatic aborted JS scans fail.
- Private bounded per-file journals, cooperative per-config apply locks, exact
  trash receipts and read-only recovery are implemented. Doctor/recovery report
  recorded owners; no PID-based automatic unlock or operation replay is allowed.
- Schema export and structured JSON apply/clean errors support agents without
  terminal scraping. Automation must retain reviewed targets/selections, bound
  its buffers, check completion and never widen deletion permissions itself.
- Turbo CLI build transitively hashes inlined core/protocol sources. Native test
  availability is explicit; required CI coverage fails when the engine is absent.
  Workflow input interpolation, root-script lint/format coverage and hooks were
  tightened. Native direct stderr escapes terminal control characters.

## Audit inventory

| ID  | Status at this checkpoint                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Implemented; same-drain destructive races reproduced and tested.                                                                                            |
| 2   | Implemented; fresh protected-root inode aliases in JS/Rust; Linux bind fixture.                                                                             |
| 3   | Implemented; transit build inputs; controlled core/protocol hash changes checked.                                                                           |
| 4   | Implemented; direct JS API validates proc-relative and leaf-symlink targets.                                                                                |
| 5   | Implemented for reported engine/contract/CLI tests; explicit skips, required-native CI environment and build ordering.                                      |
| 6   | Implemented; live trash choice prevents stale hard-delete confirmation.                                                                                     |
| 7   | Open; repeated mount-table parsing needs measurement and safe fresh-check caching design.                                                                   |
| 8   | Implemented; proc task cwd/root/fd/fdinfo spellings rejected in both engines.                                                                               |
| 9   | Implemented; scan roots within protected VCS metadata refused.                                                                                              |
| 10  | Implemented; release dispatch version passed through environment.                                                                                           |
| 11  | Implemented; ignored config/engine intent warned; doctor actually uses engine.                                                                              |
| 12  | Reproduced slot swap fixed by a fresh identity check; remaining pathname race requires handle-based work and Windows qualification.                         |
| 13  | Implemented POSIX separator handling; Node installed CLI verified; Bun 1.4.2 realpath restriction documented, fails closed.                                 |
| 14  | Open release risk; macOS nested mount protection requires implementation and actual mount qualification.                                                    |
| 15  | Partial; bounded batching/yields and fewer state allocations; per-batch row/group rebuilding and React drain acknowledgement remain.                        |
| 16  | Partial; direct host tests cover progress, cancellation, refusal journals, contention and signal lifecycle; more crash/trash/history fault coverage needed. |
| 17  | Open; enumerate plan-loader trust guards and add missing adversarial cases.                                                                                 |
| 18  | Open; reconcile SPEC with runtime floor, roots, VCS names and output modes.                                                                                 |
| 19  | Implemented; doctor no longer probes an unused external du.                                                                                                 |
| 20  | Open; actual Windows junction and console-control branch qualification.                                                                                     |
| 21  | Implemented; native CLI terminal-control stderr regression.                                                                                                 |
| 22  | Implemented; fixture regeneration forwards selection policy.                                                                                                |
| 23  | Implemented; one lint-staged configuration includes Rust and mts/cts.                                                                                       |
| 24  | Implemented; local trash directories ignored by Git.                                                                                                        |
| 25  | Open policy decision; over-limit dry-run preview should remain read-only without silently authorizing apply.                                                |
| 26  | Open; document anchor/prose/flag consistency checks exceed current link checking.                                                                           |
| 27  | Partial; architecture/workspace maps refreshed; thin agent router still needs all workspace entries.                                                        |
| 28  | Implemented; root scripts included in lint/format tasks and their cache inputs.                                                                             |
| 29  | Open; installer checksum, interruption and atomic promotion fault tests.                                                                                    |
| 30  | Open; pack staging must stop mutating tracked platform manifests.                                                                                           |
| 31  | Partial; per-event Set allocation removed; shared vocabulary parity remains.                                                                                |
| 32  | Open measurement; do not memoize away deletion-time identity checks.                                                                                        |
| 33  | Open measurement; avoid repeated serialization/hash work while retaining validation.                                                                        |
| 34  | Open measurement; cheap-command startup and lazy import opportunities.                                                                                      |
| 35  | Open measurement; capability cache must invalidate on binary/environment changes.                                                                           |
| 36  | Open measurement; bounded Node worker IPC optimization.                                                                                                     |
| 37  | Open measurement; hardlink metadata precision must survive any stat reduction.                                                                              |
| 38  | Implemented; explicit config replaces the project file layer, documented.                                                                                   |
| 39  | Implemented; doctor exercises selected scan engine and probes safe native apply capabilities.                                                               |
| 40  | Open compatibility decision; dependency age alone does not prove a vulnerability.                                                                           |
| 41  | Open measurement; link-dense Rust lock contention versus sharded/exact dedup.                                                                               |
| 42  | Open low-priority measurement; bounded sizing-batch bookkeeping.                                                                                            |
| 43  | Open; distinguish trash initialization errors from changed-path failures.                                                                                   |
| 44  | Open cleanup; dead fallback gate should be removed with caller review.                                                                                      |
| 45  | Open; declare and qualify MSRV before promising older Rust toolchains.                                                                                      |

## Next release work, in order

1. Close macOS mount/trash transaction gaps and qualify actual Windows/macOS
   behavior. Linux JS pathname removal retains a mid-walk mount race; disclose
   it and prefer descriptor-constrained native removal where supported.
2. Reconcile discovery/stream/apply resource charges and directory admission.
   Measure entry-heavy trees; design paging/spill before raising bounds. A 600 GiB
   sparse file does not qualify millions of files or cold/network deletion.
3. Replace unacknowledged UI producer yields with actual committed-frame
   backpressure; window the expanded sidebar and benchmark live streaming,
   filtering, bulk selection and cancellation at 25k–100k candidates.
4. Bound aggregate journal storage and qualify disk-full/crash behavior. Design
   overlapping-target coordination across config dirs/users before replacing
   the conservative global lock. PID liveness is diagnostic, not unlock authority.
5. Complete dependency advisory checking, installer/pack fault tests, saved-plan
   lifecycle and opt-in redacted diagnostic exports. Never transmit paths or
   dependency inventories without the user's authorization.
6. Verify installed packages and real consoles on the five shipped targets;
   gate publishing on exact-commit hosted checks and reviewed release assets.
   Commit/push authorization does not authorize publication.

## Evidence boundaries

Required repository and Rust gates are recorded separately from benchmark JSON.
Rendered UI tests use OpenTUI native in-memory frames, not a physical terminal.
Warm benchmarks use owned synthetic trees and record their engine hash. No test
here proves constant RSS, no leaks, no partial recursive removal, immunity from
hostile filesystem writers, or allocated 200–600 GiB production readiness.
