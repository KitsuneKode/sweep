# Traversal engine

- **Status:** `implemented locally` — phases 1–4 have local code and tests.
  Native cooperative control, authoritative outcomes, bounded sizing/traversal,
  sparse timers and failure accounting are implemented on main. Phase 5 is not
  needed for the demonstrated traversal gate. Hosted OS/runtime and security
  qualification remain; see [remediation](codebase-audit-2026-10-01/remediation.md).
  The separate worktree at `3e458e8` was semantically reviewed rather than merged.
  It was [archived and retired](traversal-worktree-retirement.md) on 2026-10-07
  after restoring the missing progressive partial-size marker. Branch history
  and the complete dirty worktree are preserved locally.
- **Scope:** `engine`, `performance`, `protocol`
- **Created:** 2026-10-01
- **Updated:** 2026-10-07
- **Commit:** `f5c2270` (implemented source checkpoint; retirement follows)

Execution plan for both engines. Background research lives in
[.reference/filesystem-traversal.md](../.reference/filesystem-traversal.md).
The longer write-up in
[.docs/traversal-architecture-research.md](../.docs/traversal-architecture-research.md)
is input. Where section 6 of that write-up disagrees with this file, this
file wins. Audit findings A01, A02, A03, A05, A08, and A09 are absorbed here.
UI selection cost (A04) and history (A10) stay in
[the audit](codebase-audit-2026-10-01/audit.md).

Scanner, protocol, and `sweep-fs` overlap; execute changes sequentially.
The user authorized commits/pushes and worktree retirement. Publication still
requires a separate instruction.

## Original problems

Rust loses on a large tree because sizing one fat artifact is a sequential
walk that allocates a `Utf8PathBuf` and calls `lstat` per child
(`apparent_size` in `crates/sweep-fs`). The JS engine hands that same tree
to `du`. Eight size workers do not help when one `node_modules` holds the
files.

Discovery has a second, smaller problem. Rust calls `par_iter` on the
children of every directory and takes one mutex for every visited directory.
JS calls `mapPool(..., 16)` inside every directory, so concurrency is not 16. Node's filesystem threadpool still defaults to 4.

Name matching can freeze either engine before the walk matters. `*` and `?`
are compiled to `.*`. The patterns are already anchored. Anchors do not
stop backtracking. Audit A01.

Rust apply looks up each selected id with `Vec::contains` (`apply.rs`). JS
already uses a `Set`.

## Original implementation decisions

The current contract in [.docs/architecture.md](../.docs/architecture.md) includes
subsequent per-artifact hardlink and portable sizing refinements.

These are settled. Do not reopen them inside a phase.

1. **JS keeps calling `du` until the phase 2 gate passes.** The gate is a
   warm-cache release build on the fat fixture: median Rust total time less
   than or equal to median JS total time, and Linux byte totals equal to
   `du -sb`. Cold cache is recorded, not required.
2. **Apparent size matches `du -sb`.** `st_size`. Symlinks count their own
   length and are not followed. Directory nodes are not added on top of
   their children. GNU coreutils 9.7 `du.c`: `-b` is apparent size;
   `FTS_PHYSICAL` is the default symlink policy.
3. **File hard links are counted once.** Only for non-directories with
   `st_nlink > 1`, which is GNU `du`'s rule for a single physical walk
   (`!S_ISDIR && st_nlink > 1`, unless `-l`). Directory `nlink` is at least
   2 because of `.` and `..`. Those inodes stay in the directory-cycle set,
   not the file set. A mutex taken only on `nlink > 1` is enough. Do not
   shard that set, and do not add `rustc-hash`.
4. **Unreadable size is unknown, not zero.** Add optional `bytesKnown` on
   the candidate. Absent means an old producer. New scans set it `false`
   when a subtree could not be read. Keep any partial sum. `summary.exact`
   is true only when exact sizing was requested and every candidate has
   `bytesKnown !== false`. Schema `minimum: 0` stays. No negative sentinel.
5. **Discovery scheduling is one fixed pool of directory tasks, depth-first.**
   Local LIFO, steal when idle, same shape as `ignore::WalkParallel`.
   Ripgrep switched this walker off a breadth-first queue because a wide
   tree kept state for the whole width; the author's crates.io measurement
   in commit `139f186` went from almost 1GB peak to 50MB. Cap at
   `min(available_parallelism, 8)`. No user-facing thread flag. No
   `3 × cores`. `crossbeam-deque` is allowed in phase 3. `jwalk` is
   unmaintained and is not a dependency. The `ignore` crate is not a
   dependency: its default gitignore would hide `node_modules`.
6. **Classification uses `file_type`.** On Unix that is `d_type` and it is
   free (`std::fs::DirEntry`). `metadata()` is a separate stat. Discovery
   stats an entry only for size, mtime, `(dev, ino)`, or `DT_UNKNOWN`.
   Sizing a matched artifact still stats every file inside it. GNU `du`
   forces `FTS_AGAIN` for that second case. Extra threads do not speed up
   one flat directory; parallelism is across subdirectories. Do not build
   a `PathBuf` for every name in a multi-million-entry directory. gnulib
   `fts` notes that 4,000,000 resident child entries are about 1GiB and
   caps an unsorted child list at 100,000.
7. **A directory `st_nlink` of 2 is not "no children."** Gnulib turns that
   leaf shortcut off on NFS, CIFS, AFS, proc, and unknown filesystems.
   Always `readdir`. `DT_UNKNOWN` means stat.
8. **Globs stay `*` and `?`.** No globstar. Match results for existing tests
   stay the same, including `*` matching `/` inside path ignore patterns.
   Implementation is an exact `Set` plus bounded wildcard matching, without
   backtracking regexes. Reject
   patterns longer than 128 characters at config load.
9. **Plan candidate order is sorted by path** before ids are compared in
   snapshots. Do not change the id algorithm. Stream tests assert
   found-before-updated per id, not a global order.
10. **NDJSON batching already exists** (`EMIT_BATCH_AT` 64, first flush
    immediate, in `sweep-engine-cli`). Do not rebuild it. Result channels
    stay bounded. `fd` uses `2 × threads` for its output channel. N-API and
    Bun FFI are out of this plan. The fat walk must not emit one event per
    file.
11. **Deletion stays on the current rules.** A directory is
    `remove_dir_all`. A symlink candidate is unlinked, never passed to
    `remove_dir_all` (`remove_dir_all` fails unless the path is a directory,
    and it must not be given a link whose target should be removed). No
    extra delete concurrency. Cooperative cancel lands in phase 4.
    `openat` sizing is phase 5 and only if phase 2 misses the gate. That
    open uses `O_DIRECTORY|O_NOFOLLOW`, the GNU `fts_opendir` shape. It
    does not copy uutils `safe_du`, which stats with no-follow and then
    opens the child with follow. `O_NOFOLLOW` does not protect `..`.
12. **A scan root that is a symlink is not entered.** `walkdir` and
    `ignore` follow a root symlink "because the user named it." Sweep's
    `mark_dir` refuses it. Keep the refusal.
13. **`--one-file-system` is out of scope.** Directory `(dev, ino)` dedupe
    stays. Open directory fds stay capped: a worker may hold one, queued
    work must not hold one per directory. `walkdir` defaults `max_open` to 10. gnulib `fts` keeps a parent-fd ring of 4.
14. **Windows long paths get a test, not a speculative `\\?\` layer.** Add
    the prefix only if that test fails. The reported number stays apparent
    size. Do not switch to `st_blocks`, and do not describe that number as
    unique blocks freed: removing one hard link leaves the data while
    another link remains.

## Phase 0 — Measure before rewriting

No behavior change.

- Extend `packages/core/benchmarks/engine-comparison.ts` with a `fat`
  scenario: one `node_modules` containing many files, plus a `wide`
  scenario that already exists. Default fat size stays out of `bun run check`.
  A local run of about 20_000 files is the first gate; 100_000 is the
  number to quote once, on a quiet machine.
- Report warm median total, first discovery, and first size for JS and
  release Rust. On Linux, also run `du -sb` on that single artifact and
  record its time next to the engines.
- Document the command and the warm-cache limit in `.docs/testing.md`.
- Record peak RSS if `/usr/bin/time -v` is available. Do not fail the run
  on RSS.

**Done when:** one JSON file exists for fat+wide, warm cache, and the
testing doc names the command.

## Phase 1 — Matchers, then the apply lookup

Security before a faster walk. A hostile ignore pattern must not be able
to dominate the benchmark.

- Replace the regex glob in `packages/core/src/scanner.ts`,
  `packages/core/src/config.ts`, and `PatternMatcher` in
  `crates/sweep-fs/src/lib.rs` with one exact set and one linear `*` / `?`
  matcher. Share the behavior, not a crate. Case folding stays as it is:
  macOS and Windows only.
- Config load rejects a pattern longer than 128 characters with the
  existing config error type.
- In `apply_plan`, build a `HashSet` from `selected_candidate_ids` once.
  Leave the protocol field a `Vec`. JS already uses a `Set`; do not change
  it.
- Tests: existing glob and ignore cases pass; a pattern of many `*` against
  a long name finishes in well under a second; Rust apply selects the same
  ids as before.

**Done when:** `bun run check` and `bun run rust:check` pass. A01 and A05
are closed by tests, not by inspection.

## Phase 2 — Size one artifact the way `du` sizes one tree

This is the change that can make Rust faster than JS on a fat tree.

Inside `apparent_size` / `exact_size`:

- Parallelize subdirectories of the artifact on the existing size pool
  (`SIZE_MAX_INFLIGHT` 8). A directory with one child is walked on the
  current worker. Do not spawn a task per file. A single flat directory
  stays one reader. Stream names and match them before retaining a path.
- One reusable path buffer per worker. No `Utf8PathBuf` per child.
- One stat per entry that needs a size. Use `file_type` to skip the extra
  Unix reparse `lstat`. Windows still checks
  `FILE_ATTRIBUTE_REPARSE_POINT` and does not descend junctions.
- File hard links: thread-local sets, merged under one mutex only for
  `nlink > 1` non-directories. First sighting counts. Later sightings add
  nothing.
- Symlinks and reparse points: own length, never followed.
- Unreadable file or directory: partial sum stays, `bytesKnown: false`.
- Discovery still emits the candidate before its size. A size for that
  candidate is emitted when that artifact finishes, and also on a short
  timer so a sparse tree does not wait for a batch of 16 or 50 (A09).

Protocol:

- Optional `bytesKnown` on the candidate schema, TS type, both engines, and
  the stream validator.
- UI treats `bytesKnown === false` after completion as an incomplete size.
  During the scan, a missing update still means "sizing".
- Parity fixtures gain a hard link and a symlink. Linux asserts both
  engines equal `du -sb`.

JS estimated sizing stays `du -sb` / `du -sk`.

**Gate:** release binary, warm cache, fat fixture, at least 5 samples.
Rust median total `<=` JS median total. Linux bytes equal `du -sb` on that
tree, including the hard link counted once. If the gate fails, do not
switch JS off `du`. Go to phase 5 before claiming the size walk is done.
Phase 3 may still proceed; it does not depend on beating `du`.

**Done when:** the gate result is written next to the phase 0 JSON, and
`bun run check` plus `bun run rust:check` pass.

## Phase 3 — One walk queue on each engine

- Rust discovery: delete per-directory `par_iter`. One pool, directory
  tasks, LIFO plus steal, cap 8. Depth-first on purpose: a breadth-first
  queue retains every wide level. `crossbeam-deque` is the expected
  dependency. Directory cycle dedupe is sharded or thread-local and merged.
  It stores directories only. Do not also keep an fd for every queued
  directory.
- Do not stat a Unix entry just to learn that `file_type` already said it
  was a directory, a file, or a symlink. Still stat when `(dev, ino)` is
  required for cycle detection and `d_ino` plus the parent device is not
  enough. Bind mounts are the case that needs the device id.
- JS: one queue for the whole scan, cap 16 in flight, not 16 per directory
  (A03). The waiter list is a cursor, not `Array.shift`.
- JS visited directories use `lstat(..., { bigint: true })`. A `number`
  inode has already lost precision past `2^53`; wrapping that number in
  `BigInt` does not get it back.
- Streaming order may change. Snapshot comparison sorts by path. Per-id
  found-before-updated stays.

**Done when:** a wide fixture does not create more than the cap of
concurrent directory reads, existing parity sets match, and both check
commands pass.

## Phase 4 — Stop a Rust apply without losing the report

A02/A06 implemented locally. No new delete parallelism.

- An explicit portable plan/start/cancel control channel stops further scheduling
  while the running removal finishes. Initial EOF/malformed start fails before
  deletion. Begin/deleted feedback streams during work; the final report carries
  deleted, failed, covered and unattempted outcomes for every unique selected ID.
- The host drains the report. A 30-second cancellation watchdog reports unknown
  outcomes after force-kill, without destructive retry. Old engines lacking this
  capability are refused before apply; the user can explicitly choose JS.
- Regression tests cover pre-abort, duplicates, nested coverage, conflicting
  types, live cancellation and a closed initial channel. Size guards refresh
  observations before removal. CLI counts/history use actual operation outcomes.

**Local gate:** schema-valid interrupted reports and matching callbacks/history
pass. Hosted Windows/macOS/ARM64 and stuck-filesystem qualification remain
release requirements.

## Phase 5 — Unix `fstatat` only if phase 2 missed the gate

Skip this phase when the gate passed.

- Size with an open directory fd and `fstatat(..., AT_SYMLINK_NOFOLLOW)`.
  The open itself is `O_DIRECTORY|O_NOFOLLOW`. `rustix` is allowed on Unix.
  Windows stays on the phase 2 pathname walk. Do not open the child with
  follow after a no-follow stat.
- Same bytes, same `bytesKnown` rules, same hard-link rule.
- Re-run the phase 2 gate. If it still fails, stop and publish the numbers.
  Do not add FFI, `statx`, or `getattrlistbulk` in this plan.

## Explicitly not in this plan

- In-process N-API or Bun FFI.
- The `ignore` crate, `jwalk` (unmaintained), or `rustc-hash`.
- A breadth-first directory queue.
- Skipping `readdir` because a directory's `st_nlink` is 2.
- Entering a scan root that is a symlink.
- Reporting `st_blocks` as the candidate size.
- Fuzzy matching on the walk.
- A `--one-file-system` flag or a `--threads` flag.
- Switching the JS sizer off `du` before the gate.
- More parallel deletes.
- Rewriting UI grouping (A04) or history truncation (A10).

## Verification

Each phase that touches TypeScript runs `bun run check`. Each phase that
touches `crates/` also runs `bun run rust:check`. The fat benchmark is not
part of `check`.

Quote a result with the machine, warm or cold cache, binary profile, and
fixture shape. diskus's 10× cold-cache figure is that author's laptop, not
a sweep target.

## Terminal cancellation qualification

The root bridge now starts controlled apply in a separate Unix process group.
An owned foreground-process-group SIGINT test verifies that the host cancels
through the channel and drains the native outcome report. Windows installs a
console callback that only sets a static atomic; actual Windows console behavior
still needs execution on that platform. Forced cancellation of a deliberately
stuck child passes the 30-second unknown-outcomes watchdog regression. Crashes
and invalid output after begin also produce an explicit unknown-outcomes error.

## Resource-bounds follow-up (2026-10-02)

The old exclusion on switching JS away from `du` is superseded for resource
safety by [resource bounds and release qualification](resource-bounds-and-release.md).
External sizing cannot enforce the shared inode budget. Current apparent scans
use metadata batching; the new benchmark records the tradeoff. Phase 4 controlled
apply and Phase 0 fat/wide evidence were initially local. Source and the
[fat/wide evidence](../.docs/benchmarks/fat-wide-2026-10-07.json) are now committed;
see [.docs/testing.md](../.docs/testing.md). Phase 5 syscall sizing remains deferred because the
performance gate passed. Deletion race/mount qualification is a separate safety
question, not a reason to add speculative sizing FFI.
