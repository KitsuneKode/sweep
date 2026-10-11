Status: in_progress
Scope: compact native discovery experiment, session failure handling, public writing
Created: 2026-10-08
Updated: 2026-10-11
Commit: checkpoint based on bda7c82; see git history

# Compact discovery and follow-up patches

Baseline: `bda7c822618112b6061a62a34cdfa34c616e8369`. Work stays inline.
This plan implements the read-only experiment from the round-four audit before
changing the default TUI storage contract. Existing resource limits stay in place.

## Tasks

1. Build a compact native index from a validated review snapshot. Intern shared
   directory/metadata strings, use record offsets and an explicit selected-ID set.
   Queries carry generation and revision; stale queries and queue mutations fail.
   Cap records, retained charges, query text, selection batches and page size.
   Queue mutation validates the entire batch before changing anything. Blocked
   records cannot be queued. The index has no filesystem mutation interface.
2. Expose the experiment through an internal NDJSON native command and a bounded
   host adapter. The host validates the input plan before transferring it. One
   request is outstanding; EOF, cancellation and stalled replies close the child.
   Responses must match the generation, revision and request. No engine fallback
   or deletion is possible. Input and output have explicit byte caps.
3. Compare native filtering/selection/paging with the JS reference, including
   literal POSIX backslashes, unknown bytes/mtime, blocked IDs, stale generations,
   duplicate/unknown IDs, Unicode and cancellation. Query order is deterministic;
   locale-dependent UI name sorting is not silently replaced by native ordering.
   Measure 5k/50k/100k records and repeated replacement, index retained charges,
   peak process RSS, transfer size and query latency. Target: <=64 MiB retained
   index charges at 100k, <=256 records and <=1 MiB per reply. These are experiment
   targets, not physical-device or 600 GiB qualification.
4. Inject a view failure during/after apply and move operation/result ownership
   outside React if the result can be lost. Stop requests drain the active apply;
   view failure cannot become an ordinary user cancellation.
5. Review visible strings and public docs with better-writing. Correct stale
   deletion, recovery and hosted-qualification claims. Prepare site-ready Markdown
   with task-first intros, concrete limits and links to owning guides.

## Integration gate

The default TUI remains on its existing retained index until the experiment
proves semantics and the reducers can consume aggregates and bounded pages.
Page eviction must never change selection. Apply always uses a newly constructed
explicit plan and the existing identity, containment and outcome validation.
Saved-plan export remains subject to its existing resource and file-size limits.

## Execution record

- Pre-flight: native paging produces partial row sets; existing UI reducers consume
  all candidates. Integrating pages directly would silently understate queue scope.
  Ruling: qualify a read-only adapter first; keep default UI integration gated.
- No additional subagents. Tests use owned fixtures; no user data is deleted.
- Implemented: compact index, bounded internal NDJSON command, atomic revisioned
  selection and a benchmark client. The production host adapter remains open.
- Added native snapshot/queue/cancellation/Unicode/page-budget regressions and
  JS/native filtering comparisons. Filter whitespace follows JavaScript's BOM
  and NEL semantics; page accounting includes array overhead before materializing
  records. Saved-plan/native reason bounds now match the streamed-candidate limits.
- The 100k synthetic snapshot used about 40.1 MiB of retained logical charges and
  about 92.0 MiB peak native RSS in the final refreshed run. The retained budget
  target passed. Full host/UI memory, repeated generation replacement and sorted
  UI parity remain open; see the [raw report](compact-discovery-2026-10-08.json)
  for current binary hash, compiler and measurements.
- UI receipts name a single reviewed path. Confirmations explain symbolic-link
  removal and manual trash restoration; CJK/grapheme cell layout and narrow rows
  retain the size column. The inspector wraps long paths.
- Terminal close requests drain an active apply, then finalize the session.
  Bridge tests cover active cancellation. Linux PTY tests cover completed apply
  followed by quit, SIGHUP or SIGTERM and assert alternate-screen restoration.
- Release fixes: atomic manifest replacement/restoration, preserved invalid
  backups, portable CLI cleaning, direct-publication source/CI guards and portable
  native format/architecture checks. No publication was performed.
- Local gates passed: `bun run check` (49 tasks), `bun run rust:check` (8 tasks),
  600 benchmark queries across 5k/50k/100k snapshots and the three completed-apply
  Linux PTY exits. These results do not replace hosted or physical-device checks.

## Remaining work

1. Implement a validated production host adapter, including malformed/fragmented
   replies, bounded waits and generation replacement. The benchmark client is
   not a production adapter.
2. Replace UI reducers with aggregate/page consumers before evicting candidates.
   Qualify queue persistence, ordering, saved-plan export and repeated sessions.
3. Qualify active SIGHUP/SIGTERM with the real engine and view failures during
   removal. Keep the journal authoritative if the view disappears.
4. Continue macOS/Windows mount/path replacement qualification, overlapping-root
   coordination and bounded journal/extraction retention. No new guarantee is
   made for these surfaces or allocated 200–600 GiB trees.
