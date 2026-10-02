# Traversal-engine worktree review and scale architecture

- **Reviewed:** 2026-10-01
- **Root HEAD:** `37012df`; working tree contains overlapping traversal/UI changes
- **Worktree:** `.worktrees/traversal-engine`, branch `traversal-engine`, source HEAD `3e458e8`
- **Package source version:** CLI `0.3.1`; Rust workspace `0.1.0`; protocol `1`
- **Integration:** reviewed in place; not cherry-picked, merged or committed here

## What the worktree improves

`3e458e8` adds bounded glob matching, a fixed discovery queue, directory-type
classification before allocation, hardlink-aware sizing, optional bytesKnown,
selected-ID lookup via HashSet and native apply outcome fields. These are useful
algorithmic improvements. The branch's existence or status `implemented` does
not establish that every phase meets its correctness and performance gates.

## Review findings

1. **Native cancellation remains incomplete at the host boundary.** The worktree
   arms libc SIGINT/SIGTERM handlers and adds an atomic stop flag, but the Bun
   bridge retains the 250 ms SIGKILL escalation. A slow in-flight remove_dir_all
   can still lose its final report. Windows process termination also needs a
   portable cooperative channel. Raw signal handler installation results are
   ignored. These changes should not be described as cross-platform truthful
   interruption until executed and tested end to end.
2. **Outcome partition needs explicit covered-child behavior.** Native dedupe
   drops child selections under a parent. deletedPaths/unattemptedPaths alone
   do not account for all selected IDs after dedupe or duplicate path selection.
   Define covered-by-parent outcomes and failed-parent consequences before
   generating reliable receipts/history.
3. **Sizing uses nested Rayon parallel iterators from std sizer threads.** The
   progressive jobs do not enter one explicit shared eight-thread pool, so the
   nested work may use Rayon's global CPU-sized pool while the std workers also
   run. Thread and memory budgets must cover the complete scan, not each pool
   independently. The continuation on main now dispatches onto one shared pool.
4. **Unicode filenames are lost in parts of the worktree sizer.** Converting
   directory paths to Utf8PathBuf drops invalid-UTF-8 subtrees. The main
   continuation uses std PathBuf internally and has a non-UTF8 sizing regression.
   Wire discovery still has a separate UTF-8 contract and skipped-directory rule.
5. **Worker panic can strand termination.** The worktree pending-job counter
   assumes every job decrements it. A callback panic can leave other workers
   spinning. Main reproduced this as a timeout and now cancels all workers,
   propagates the panic and closes the progressive sizing channel before joins.
6. **Thread cap is not a hard memory bound.** Queued paths, visited-directory
   identities and retained candidates still grow with the tree. Depth-first
   queues help locality; they do not make an enormous flat directory free.
   A file descriptor, queue and candidate-budget stress suite remains needed.
7. **Iterator failures must affect completeness.** read_dir.flatten discards
   errors yielded after opening a directory. Main sizing now iterates Results
   explicitly and marks the sum incomplete. The reviewed worktree still uses flatten in discovery. The root continuation
   now handles both entry-iterator and file-type errors, counting a directory
   once, with injected-error regression coverage.
   Windows junction/reparse and root failure behavior need actual OS execution.

## Architecture implemented in this continuation

Discovery: existing crossbeam LIFO/steal pool, capped at eight workers, with
shared stop-on-panic and an idle backoff so a sparse disk tail does not spin
seven CPU cores. It still retains candidate and visited-directory state.

Sizing: one shared Rayon pool of eight workers. A dispatcher outside that pool
receives a bounded 256-entry discovery channel and admits at most 32 active
candidate jobs. Subdirectories subdivide in batches of 64 at up to three
parallel levels on that same pool. Files are priced from DirEntry metadata
without allocating a retained path per file; deeper sizing uses a local LIFO
rather than recursive calls/one open directory per ancestor. Directory identities
prevent repeated descent; non-directory hard links share a per-artifact set.
The remaining path-open race is documented, not claimed eliminated.

Streaming: first discovery flushes immediately. A scoped native timer flushes
pending found/updated/progress batches at a 16 ms cadence even if no later event
arrives. Finish joins the timer before scan_completed. The JS du sizer now has
a 16 ms sparse-batch timer, drains/aborts owned tasks, and removes scan abort
listeners on success, failure or cancellation. The JS global 16-worker walk now
pops completed frames instead of retaining the entire queue's history.

UI: first reveal is immediate; later keyed updates coalesce over 60 ms or 200
pending IDs. Size completeness is separate from discovery, failures stay visibly
incomplete, and incomplete generations cannot apply or export executable plans.

## Why threads here, and what comes next

The work is blocking filesystem enumeration/stat, so a bounded worker pool is
useful; adding an async runtime or async mutex does not reduce those syscalls.
Keep locks around short bookkeeping sections, never around a whole subtree walk.
Use a dispatcher/condition variable for backpressure and explicit atomic flags
for lifecycle control. Existing host async streams keep the UI responsive.

[Benchmark results](benchmarks.md) show where this architecture wins and where
spawn cost or a single flat reader limits it. Do not add another runtime,
lock-free hash table, FFI binding or OS-specific syscall path solely because it
sounds faster. If flat-directory profiling proves a remaining bottleneck, make
an isolated Unix directory-fd/no-follow prototype, compare byte parity and p99,
and keep Windows fallback and adversarial path tests. If one million discovered
candidates exceed memory targets, the protocol/UI need explicit retention limits
or paged candidate storage; a thread cap cannot solve that.

Run the owning gates before integration: bun run check and bun run rust:check.
Require cooperative apply outcomes, native-package ARM64 execution, Windows and
macOS scans, slow-reader streams, network filesystems, permission changes,
symlink swaps, cold caches and repeated-scan memory measurements before broader
best-in-class or leak-free claims. Remaining plans are linked from the
[audit index](README.md).

## Final worktree refresh

On 2026-10-02 the worktree still points at `3e458e8`, without integration. Its
`bun.lock`, `package.json` and `turbo.json` now have unrelated tooling changes.
They were preserved. Root remediation implements the cooperative apply channel,
full selected-ID outcome partition, shared sizing pool, Unicode leaf sizing,
worker failure cleanup and discovery-error feedback described above. See the
[remediation report](remediation.md) for verified fixes and open qualification.
