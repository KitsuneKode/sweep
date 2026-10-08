Status: completed
Scope: screenshot feedback, live UI delivery, native removal activity
Created: 2026-10-08
Updated: 2026-10-08
Commit: 762fc15067eda095b457c08885c5fa7612145eb0

# UI and streaming follow-up

The screenshot reports were verified against current source and renderer tests.
Work is inline, without new subagents. This follows
[round 3](audit-round3-2026-10-07.md); it does not replace the remaining
platform, mount-race or large allocated-tree qualification work.

## Implemented

- Queue meter names byte coverage and separately shows selected/total items.
  A zero-byte selected artifact no longer looks like an empty queue. Partial
  byte totals do not advertise an exact percentage.
- Single-item confirmation discloses the other queued items; results show the
  remaining queue. Footer labels distinguish delete-this from apply-queue,
  and the risk tally explicitly describes the queue.
- Enter in confirmation displays a pinned reminder instead of silently doing
  nothing. An early `y` explains the guard. Destructive confirmation remains
  deliberate; no automatic queue-to-single-item fallback was added.
- Native Linux descriptor-based removal counts successful unlink/rmdir
  operations. Activity events are capability-negotiated and opt-in, throttled
  after the first removal to 100 ms intervals and validated for active ID,
  safe integer and monotonic count. Final reports and journals retain their
  artifact outcome semantics.
  JS, trash and non-Linux paths show animated activity without made-up counts.
- Live producer waits for React commit receipts. Delayed commits coalesce
  buffered updates; cancellation releases waiters. Rejected and synchronous
  delivery failures return to the scan instead of escaping timer callbacks.
- Burst frames grow from 200 to 2,000 records, retaining the 60 ms timer and
  immediate first reveal. App, groups, rows and reducer lookups share one
  immutable candidate index instead of building several maps. Historical
  index caches are bounded and cleared at generation/session boundaries.
- Sizing-only updates reuse sidebar topology; totals and sorting refresh once.
  Candidate path/ID changes invalidate the topology. Fresh/reused output parity
  and renamed-path tests pass.
- New flat scanner fixtures use ignored `.scratch` with normal teardown.
  Repository config ignores old `.plans/sweep-flat-test-*` remnants and has no
  arbitrary 10 GiB cap. Existing retained evidence is preserved. Explicit user
  caps and all identity/mount/resource guards remain supported.

## Evidence and limits

The clean committed checkpoint passed all nine local verification steps,
including required check, rust:check, installed packages and standalone smoke.
[All eight exact-commit hosted jobs](https://github.com/KitsuneKode/sweep/actions/runs/37693662912)
passed on Linux x64/ARM64, macOS Intel/Apple Silicon and Windows, plus docs and
workflow lint. No package was published; the release workflow updated version
PR #22. The archived local receipt below records the earlier pre-commit
boundary rather than claiming it is the clean-tree receipt.
Tests cover actual native-host activity, malformed events,
one-entry cooperative cancellation, untouched sentinels, queue disclosure,
Enter feedback and commit receipts across rescan cancellation.

The [25k adaptive producer](ui-streaming-followup-2026-10-08/stream-25k.json)
completed in 6.8 s with 48 batches, one outstanding commit and 686 MiB sampled
peak RSS. The fixed-frame diagnostic exceeded 1 GiB and stopped. After forced
diagnostic GC/teardown its heap shrank substantially while RSS remained high;
the bounded-cache change alone was insufficient. No forced GC runs in the app.
The [50k adaptive case](ui-streaming-followup-2026-10-08/stream-50k-refused.json)
also exceeded 1 GiB and stopped, at 70 batches and about 1,049 MiB. This is a
failed large-UI qualification, preserved rather than increasing the probe cap.
Input sample counts are below 100; recorded tail percentiles are observations,
not statistical p99 qualification or device guarantees. Retention remains too
large to claim low-memory readiness. These producers use the real app/reconciler
and native in-memory output, but no filesystem enumeration or physical terminal.
[Local receipts and artifact hashes](ui-streaming-followup-2026-10-08/qualification-local.json)
record the exact tested source/binary and the pre-commit gate boundary.
React Doctor reports a valid OpenTUI prop and the intentional serial receipt
drain loop; neither warning was suppressed. This is not a whole-app clean claim.

## Follow-up work

1. [Incremental live indexes](incremental-live-indexes-2026-10-08.md) address the
   recorded 50k failure. Paging and measured low-memory UI profiles remain;
   current logical scan budgets are not process RSS ceilings.
2. Real allocated large-tree and long-session tests, stratified by entry count,
   filesystem shape, cold IO and hardlink/mount behavior.
3. Linux mid-delete mount-race qualification, and Mac/Windows interior mount
   and reparse boundaries. Basic installed-package apply coverage is distinct.
4. Async engine availability probes, bounded engine/worker stalls, journal and
   extraction retention, overlapping-target coordination.
5. Physical TTY qualification and extended adversarial fixtures/installer tests.

Do not claim exhaustive security, immunity to allocation failure, or 200–600 GiB
production qualification from this checkpoint.
