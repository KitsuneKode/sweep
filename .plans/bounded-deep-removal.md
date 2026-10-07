Status: done
Scope: Linux descriptor-constrained deletion
Created: 2026-10-07
Updated: 2026-10-07
Commit: f5c2270

# Bounded deep deletion

A valid 128-directory artifact reproduces the current 32-frame failure. Raising
that limit retains one descriptor per level and can exhaust low descriptor limits.
Keep the public removal API and Linux openat2 containment/mount constraints.

Retain the candidate root descriptor plus at most 16 directory iterators. Store
older frames as names and expected device/inode identities. Reopen an evicted
iterator through the candidate root, checking each ancestor identity with
BENEATH, NO_SYMLINKS and NO_XDEV on every component. Restart its enumeration:
previously processed entries have been removed, avoiding filesystem-specific
cookie assumptions. Keep one MiB of logical frame metadata at most; budget
exhaustion remains an explicit partial failure, not a success or rollback.

Cancellation is checked at each iteration and during reopening. No unbounded
file listings, pathname-recursive fallback, additional parallel delete workers
or signal hard-kill behavior are introduced. Bound tests to owned fixtures.

Acceptance: 128+ deep trees and siblings remove successfully; a child process
with RLIMIT_NOFILE=32 completes a deeper artifact; reopened ancestor replacement
by a symlink preserves the external sentinel; cancellation leaves a partial
honest outcome; existing raw-name, bind-mount and identity tests continue passing.
Measure shallow and deep layouts separately. ENOTEMPTY retry, network syscall
timeouts and non-Linux mount transactions remain separate work.

## Local results

The 128-level regression failed before this change and passes afterward. Eight
removal tests pass, including replacement ancestors and cancellation. The
required Rust gate passes all eight tasks and the repository gate all 48 tasks.
The actual release engine completed three 256-level mixed artifacts under
RLIMIT_NOFILE=32, with unselected sentinels preserved. See
[deep qualification](audit-round2-2026-10-07/deep-deletion.json).

A warm 2,000-empty-file comparison alternated the old and new binaries for
20 samples after two warmups: median full apply process time changed from
8.75 ms to 9.12 ms. These small samples do not establish p99 or general
performance equivalence. Reopening prioritizes low descriptor use and checked
identities; it adds work on very deep shapes. See
[raw measurements](audit-round2-2026-10-07/shallow-removal-comparison.json).

All nine local release-shape checks passed on the committed tree. Hosted CI
passed the five shipped targets, including actual low-descriptor native deletion
on Linux x64 and ARM64. See [hosted evidence](audit-round2-2026-10-07/deep-deletion-hosted.json)
and [checkpoint qualification](audit-round2-2026-10-07/qualification-f5c2270.json).
No allocated 600 GiB or NFS qualification is implied.
