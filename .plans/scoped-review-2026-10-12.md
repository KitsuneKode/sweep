Status: done
Scope: bounded scope totals and atomic bulk queue changes
Created: 2026-10-12

# Scoped review authority

The page owner must not infer a scope or global queue from its visible page.
Add native scope totals and one atomic scope-selection command. The host verifies
both against charged compact witnesses before accepting them.

- `null` means all scopes; `""` means artifacts directly in the target root.
  Other keys include their descendants at `/` boundaries, excluding prefix siblings.
- Bulk queueing includes safe/caution rows. Dangerous rows require an explicit
  choice. Blocked rows never queue. Clearing a scope clears every risk tier there.
- Counts, byte bounds and risk totals include hidden rows and reflect retirement.
- Scope changes retain no candidate pages or unbounded ID batches. Scope strings
  are interned and charged. Caller mutation, overlapping requests, close and forged
  receipts cannot produce a new apply plan or silently widen the queue.
- Verify native and host parity with nested scopes, literal POSIX backslashes,
  Windows separators, root artifacts, partial bytes and queues spanning pages.

This extends the bounded review owner. Default TUI integration still requires
group/cursor ordering and progressive handover; filesystem apply is unchanged.

## Results

- The native command updates an entire scope atomically with constant temporary
  storage. No-op changes preserve revision; stale revisions and malformed scope
  keys refuse before mutation. Missing scope/policy fields are rejected.
- Host scope strings are interned and charged against the existing 64 MiB cap.
  Expected totals come from compact witnesses, with a yield every 256 records.
  Overlapping requests cannot mutate those witnesses during preparation.
- Queries, totals and bulk changes now agree on root-only scope semantics.
  The host also rejects valid reviewed rows returned for the wrong scope or risk.
  Scope boundaries preserve literal POSIX backslashes and normalize Windows keys.
- Scope totals follow retirement, including partial-byte and queued-risk markers.
  Global clearing includes hidden/dangerous rows; queueing never includes blocked
  rows and includes dangerous rows only through an explicit option.
- Focused adapter/page-owner suite: 45 tests. Rust discovery suite: 9 tests, plus
  the command parser's missing-scope regression. Required workspace and Rust checks
  passed locally; clean-source verification and hosted jobs are the final gates.

The [raw report](scoped-review-2026-10-12.json) repeats 600 exact page/reference
comparisons and three 50k replacement/retirement cycles. At 100k compact records,
94,117 eligible rows were queued and cleared without a candidate export or ID batch.
Added scope witnesses stay within the host's existing memory cap. Recorded bulk
timings are individual warm observations, not a p99 or low-spec-device claim.
The benchmark holds a full reference plan, so it does not qualify rendered TUI
memory, physical filesystem races, or real allocated 200–600 GiB deletion.

## Remaining integration

The production TUI still uses its full candidate store. Bounded hierarchy/group
pages, stable cursor lookup, filtered/range bulk actions and progressive handover
remain before default activation. The scope API deliberately ignores the current
text filter; visible-only actions must keep using their explicit reviewed IDs.
